import { Argv, Computed, Context, Schema, Session, h, Universal, makeArray, Channel, User, HTTP } from 'koishi'
import * as what from 'whatlang-interpreter'
import { help, help_list } from './helper'
import { } from '@koishijs/cache'
import { } from 'koishi-plugin-puppeteer'
import type { ElementHandle, Page } from 'puppeteer-core'

export const name = 'whatlang'
export interface Config {
    requireAppel: Computed<boolean>,
    interpolate: boolean,
    interpolateCmd: boolean,
    youExtras: string,
}
export const Config = Schema.object({
    requireAppel: (Schema
        .computed(Schema.boolean()).default(false)
        .description("在群聊中，使用倒问号快捷方式是否必须 @ bot 或开头带昵称。")
    ),
    interpolate: Schema.boolean().default(false).description("启用“`$¿{ }`”插值。"),
    interpolateCmd: Schema.boolean().default(false).description("启用“`$¿( )`”What Commands 插值。"),
    youExtras: Schema.string().default("").description("在 you@ 字符串中添加的额外信息。"),
})
export const inject = ["database", "cache", "puppeteer"]


declare module 'koishi' {
    interface Tables {
        whatnoter: WhatNoter,
        whattimer: WhatTimer,
        whatcommands: WhatCommands,
    }
    interface Events {
        "whatlang/run"(code: string, session: Session): void,
        "whatlang/command"(name: string, arg: what.WhatValue, session: Session): void,
    }
}
export interface WhatNoter {
    uid: number,
    public: string,
    protected: string,
    private: string,
}
export interface WhatTimer {
    name: string,
    time: number,
    code: string,
}
export interface WhatCommands {
    name: string,
    help: string,
    h: string,
    code: string,
}

declare module '@koishijs/cache' {
    interface Tables {
        [key: `whatlang_members_${string}`]: Universal.GuildMember,
    }
}


async function getMemberList(session: Session, gid: string, ctx: Context) {
    let result: Universal.GuildMember[]
    try {
        const { data, next } = await session.bot.getGuildMemberList(session.guildId)
        result = data
        if (next) {
            const { data } = await session.bot.getGuildMemberList(session.guildId, next)
            result.push(...data)
        }
    } catch { }
    if (!result?.length) {
        for await (const value of ctx.cache.values(`whatlang_members_${gid}`)) {
            result.push(value)
        }
    }
    return result
}

function FE(segs: readonly string[], ...values: what.WhatValue[]) {
    return String.raw(
        { raw: segs },
        ...values.map(x => what.formatting(x, { depth: 1, maxArrayLength: 4, maxStringLength: 80 })),
    )
}

const sessiontoarr = (x: Session, aid?: number) => msgtoarr(x.event, aid ?? (x.user as User.Observed)?.id)
const msgtoarr = (x: Universal.Message & { message?: Universal.Message }, aid: number) => [
    x.message?.content, x.message?.id,
    x.user?.name, x.user?.id, aid,
    x.channel?.id, x.message?.quote?.id,
]
const htmlize = (
    ctx: Context,
    x: string | h,
    callback: (page: Page) => Promise<ElementHandle> = async page => {
        page.evaluate(`
            const style = document.createElement("style")
            style.append("html { background-color: white } body { display: inline-block }")
            document.documentElement.prepend(style)
        `)
        return page.$("body")
    },
) => ctx.puppeteer.render("", async page => {
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 })
    await page.setJavaScriptEnabled(false)
    await page.setRequestInterception(true)
    // block redirects
    page.on("request", req => {
        ctx.logger.debug("puppeteer request", req.isNavigationRequest(), req)
        if (req.isNavigationRequest()) req.abort()
        else req.continue()
    })
    await page.setContent(String(x))
    await page.waitForNetworkIdle().catch(() => {})
    const body = await callback(page)
    const clip = await body.boundingBox()
    if (!clip || !clip.width || !clip.height) throw new Error("content to render has zero size")
    const buf = await page.screenshot({ clip, omitBackground: true })
    // puppeteer.render() callback is only designed to return string, but can actually return anything
    // here we return an Element
    return h.image(buf, "image/png") as any
}) as unknown as Promise<h>
const imagify = (ctx: Context, x: what.WhatValue, style: Record<string, string> = {
    padding: "10px",
    "max-width": "96ch",
    "font": "32px Consolas, DejaVu Sans Mono, Menlo, monospace",
    "overflow-wrap": "break-word",
    "white-space": "break-spaces",
}) => htmlize(ctx, h("div", {style: Object.entries(style).map(p => p.join(":")).join(";")}, [what.to_string(x)]))
const svglize = (ctx: Context, x: what.WhatValue) => {
    if (!Array.isArray(x)) throw TypeError(FE`Invalid SVG elements, expected Array`)
    return htmlize(ctx,
        h("svg", {width: x[0], height: x[1], style: x[2] == null || Array.isArray(x[2]) ? "background:white" : x[2]}, (x.slice(Array.isArray(x[2]) ? 2 : 3).map(i =>
            ["path", "p"].includes(i[0]) ? h("path", {style: i[1], d: i[2]})
            : ["text", "t"].includes(i[0]) ? h("text", {style: i[1], x: i[2], y: i[3]}, [what.to_string(i[4])])
            : ["img", "i"].includes(i[0]) ? h("image", {style: i[1], x: i[2], y: i[3], width: i[4], height: i[5], href: i[6]})
            : ""
        ))),
        page => page.$("svg"),
    )
}
function headersArrToObj(pairs: what.WhatValue) {
    if (pairs == undefined || pairs === "") return []
    if (!Array.isArray(pairs))
        throw new TypeError(FE`Invalid HTTP headers ${pairs}, expected Array or Undefined`)
    const headers: [string, string][] = []
    for (let pair of pairs) {
    if (!Array.isArray(pair) || pair.length < 2) continue
        const [key, value] = pair.slice(0, 2).map(what.to_string)
        if (Object.hasOwn(headers, key)) headers[key] += ", " + value
        else headers[key] = value
    }
    return headers
}
const handleHttpError = (verb: string, url: string) => (err: HTTP.Error) => {
    if (err.response) {
        throw new TypeError(FE`HTTP error ${err.response.status} ${err.response.statusText} when getting ${url}`)
    }
    const e = err?.cause as Error & { cause?: NodeJS.ErrnoException }
    let msg = e?.cause?.message ?? e?.message ?? err?.message
    // https://github.com/cordiverse/http/blob/67cbbbba65a3010be40e82715c74541f5ec9636b/packages/core/src/index.ts#L260
    if (msg.startsWith("Invalid URL: ")) msg = "Invalid URL"
    throw new TypeError(
        `Failed to ${verb} ${FE`${url}`}${msg ? `: ${msg}` : ""}`,
    )
}
const run_what = async (code: string, session: Session, ctx: Context) => {
    let output: (h | string)[] = []
    let time = Date.now()
    let disp = ctx.setInterval(() => time = Date.now(), 100)
    let dead_loop_check: () => boolean = () => {
        if (Date.now() - time > 5000) return true
    }
    let builtins: Record<string, what.WhatFunc> = {
        ...what.default_builtins,
        help: x => help(x),
        helpall: async () => void output.push(await imagify(ctx, help_list.reduce(
            (last, n, i) => last + n + ((i + 1) % 7 ? " ".repeat(12 - n.length) : "\n"), ""
        ))),
        you: () => [
            "WhatLang/2024",
            `Interpreter/${what.version}`,
            "Environment/messaging",
            "Framework/koishi",
            ctx.config.youExtras,
            session.platform && `Platform/${session.platform}`,
            session.selfId && `Id/${session.selfId}`
        ].filter(Boolean).join(" "),
        pr: async () => h.unescape(await session.prompt()),
        propt: async x => {
            return new Promise(res => {
                const dispose = (ctx
                    .platform(session.platform)
                    .channel(session.channelId)
                    .user(...makeArray(x).map(what.to_string))
                    .middleware(async (session2) => {
                        clearTimeout(timeout)
                        let [binding] = await ctx.database.get("binding", { platform: session2.platform, pid: session2.userId }, ["aid"])
                        res(sessiontoarr(session2, binding?.aid))
                        dispose()
                    }, true)
                )
                const timeout = setTimeout(() => {
                    dispose()
                    res(null)
                }, ctx.root.config.delay.prompt)
                return
            })
        },
        prompt: async function (x, y) {
            return new Promise(res => {
                const dispose = (ctx
                    .platform(session.platform)
                    .channel(...makeArray(x).map(what.to_string))
                    .middleware(async (session2, next) => {
                        let [binding] = await ctx.database.get("binding", { platform: session2.platform, pid: session2.userId }, ["aid"])
                        let msg = sessiontoarr(session2, binding?.aid)
                        let result = await what.exec_what({ ...this, fstack: [this.fstack.at(-1).concat([msg, y])] })
                        if (!what.to_bool(result)) return next()
                        clearTimeout(timeout)
                        res(msg)
                        dispose()
                    }, true)
                )
                const timeout = setTimeout(() => {
                    dispose()
                    res(null)
                }, ctx.root.config.delay.prompt)
                return
            })
        },
        me: () => sessiontoarr(session),
        locale: () => (
            session.locales?.[0] ||
            ctx.root.config.i18n.output === "prefer-user" && (session.user as User.Observed)?.locales?.[0] ||
            (session.channel as Channel.Observed)?.locales?.[0] ||
            (session.user as User.Observed)?.locales?.[0] ||
            null
        ),
/*
        getuser: async x => {
            let user = await session.bot.getUser(x)
            return [
                user.id, user.name, user.avatar,
            ]
        },
*/
        outimg: x => void output.push(h.image(what.to_string(x))),
        outaudio: x => void output.push(h.audio(what.to_string(x))),
        outvideo: x => void output.push(h.video(what.to_string(x))),
        outfile: x => void output.push(h.file(what.to_string(x))),
        outquote: x => void output.push(h.quote(what.to_string(x))),
        outat: x => void output.push(h.at(what.to_string(x))),
        outimag: async x => void output.push(await imagify(ctx, x)),
        outksq: async x => void output.push(await imagify(ctx, x, {
            width: "max-content",
            "line-height": "1",
            "font": "32px Kreative Square",
            "white-space": "pre",
        })),
        outsvg: async x => void output.push(await svglize(ctx, x)),
        outhtml: async x => void output.push(await htmlize(ctx, what.to_string(x))),
        nout: () => void output.pop(),
        nouts: x => void output.splice(-x),
        nsend: async x => void await session.bot.deleteMessage(session.channelId, what.to_string(x)),
        send: async () => await session.send(output.pop()),
        sends: async x => await session.send(output.splice(-Math.trunc(what.to_number(x)))),
        sendsto: async (x, y) => await session.bot.sendMessage(what.to_string(x), output.splice(-Math.trunc(what.to_number(y)))),
/*
        panic: async () => {const d = ctx.before("send", () => {d(); return true})},
        panics: async x => {const d = ctx.before("send", () => {
            if (!x--) d()
            return true
        })},
*/
        cat: async url => {
            url = what.to_string(url)
            return await ctx.http.get(url, { responseType: "text" })
                .catch(handleHttpError("get", url))
        },
        ca: async url => {
            url = what.to_string(url)
            const data = await ctx.http.get(url, { responseType: "arraybuffer" })
                .catch(handleHttpError("get", url))
            return [...new Uint8Array(data)]
        },
        fetch: async (method, url, headers, data) => {
            url = what.to_string(url)
            const resp = await ctx.http(url, {
                method: what.to_string(method) as any,
                headers: headersArrToObj(headers),
                data: typeof data === "number" ? String(data) : Array.isArray(data) ? Uint8Array.from(data, x => Math.trunc(what.to_number(x))) : data,
                responseType: "text",
                validateStatus: () => true,
                redirect: "manual",
            }).catch(handleHttpError("fetch", url))
            return [resp.status, resp.statusText, [...resp.headers], resp.data]
        },
        fech: async (method, url, headers, data) => {
            url = what.to_string(url)
            const resp = await ctx.http(url, {
                method: what.to_string(method) as any,
                headers: headersArrToObj(headers),
                data: typeof data === "number" ? String(data) : Array.isArray(data) ? Uint8Array.from(data, x => Math.trunc(what.to_number(x))) : data,
                responseType: "arraybuffer",
                validateStatus: () => true,
                redirect: "manual",
            }).catch(handleHttpError("fetch", url))
            return [resp.status, resp.statusText, [...resp.headers], [...new Uint8Array(resp.data)]]
        },
        findmsg: async function (x) {
            for await (let message of session.bot.getMessageIter(session.channelId)) {
                let msg = msgtoarr({ ...message, message }, await ctx.database.getUser(session.platform, message.user.id).catch(() => null))
                let result = await what.exec_what({ ...this, fstack: [this.fstack.at(-1).concat([msg, x])] })
                if (what.to_bool(result)) return msg
            }
            return null
        },
        getmsg: async (x, y) => {
            const message = await session.bot.getMessage(what.to_string(x || session.channelId), what.to_string(y))
            return msgtoarr({ ...message, message }, await ctx.database.getUser(session.platform, message.user.id).catch(() => null))
        },
        sleep: async x => void await ctx.sleep(what.to_number(x) * 1000),
        notewc: async (x, y) => {
            if (typeof x === "number" && typeof y === "number") throw TypeError(FE`Ambiguous write of Number into public note; use a String instead`)
            if (typeof x === "number") [x, y] = [y, x]
            const uid = what.to_number(y)
            if (!Number.isInteger(uid) || uid < 0 || uid > 0xffffffff) throw TypeError(FE`Invalid uid ${y} for writing public note`)
            return void await ctx.database.upsert("whatnoter", [{uid, public: what.to_string(x)}], "uid")
        },
        notewd: async x => void await ctx.database.upsert("whatnoter", [{uid: (session.user as User.Observed).id, protected: what.to_string(x)}], "uid"),
        notewe: async x => void await ctx.database.upsert("whatnoter", [{uid: (session.user as User.Observed).id, private: what.to_string(x)}], "uid"),
        noterc: async x => {
            const uid = what.to_number(x)
            if (!Number.isInteger(uid) || uid < 0 || uid > 0xffffffff) return
            return (await ctx.database.get("whatnoter", {uid}, ["public"]))[0]?.public ?? null
        },
        noterd: async x => {
            const uid = what.to_number(x)
            if (!Number.isInteger(uid) || uid < 0 || uid > 0xffffffff) return
            return (await ctx.database.get("whatnoter", {uid}, ["protected"]))[0]?.protected ?? null
        },
        notere: async () => (await ctx.database.get("whatnoter", {uid: (await session.observeUser(["id"])).id}, ["private"]))[0]?.private ?? null,
        guildmem: async x => (await getMemberList(session, session.platform + ":" + x, ctx)).map(i => [i.user.name, i.user.id]),
        cmdset: async (x, y) => {
            if (y == undefined) throw TypeError(FE`Invalid name ${y} for setting command code, expected String`)
            return void await ctx.database.upsert("whatcommands", [{name: what.to_string(y), code: what.to_string(x ?? "")}], "name")
        },
        cmdall: async () => (await ctx.database.get("whatcommands", {}, ["name"])).map(i => i.name),
        cmdsethelp: async (x, y) => {
            if (x == undefined) throw TypeError(FE`Invalid name ${y} for setting command long help, expected String`)
            return void await ctx.database.upsert("whatcommands", [{name: what.to_string(y), help: what.to_string(x ?? "")}], "name")
        },
        cmdseth: async (x, y) => {
            if (x == undefined) throw TypeError(FE`Invalid name ${y} for setting command short help, expected String`)
            return void await ctx.database.upsert("whatcommands", [{name: what.to_string(y), h: what.to_string(x ?? "")}], "name")
        },
        cmddel: async x => {
            if (x == undefined) return
            return void await ctx.database.remove("whatcommands", {name: what.to_string(x)})
        },
        cmdget: async x => {
            if (x == undefined) return null
            return (await ctx.database.get("whatcommands", {name: what.to_string(x)}, ["code"]))[0]?.code ?? null
        },
        cmdgethelp: async x => {
            if (x == undefined) return null
            return (await ctx.database.get("whatcommands", {name: what.to_string(x)}, ["help"]))[0]?.help ?? null
        },
        cmdgeth: async x => {
            if (x == undefined) return null
            return (await ctx.database.get("whatcommands", {name: what.to_string(x)}, ["h"]))[0]?.h ?? null
        },
        cmd: async function (x, y) {
            if (y == undefined) throw new TypeError(FE`Invalid name ${y} for running command, expected String`)
            const name = what.to_string(y)
            let code = (await ctx.database.get("whatcommands", {name}, ["code"]))[0]?.code
            if (code == undefined) throw new Error("command not found")
            ctx.emit(session, "whatlang/command", name, x, session)
            return await what.exec_what({
                ...this,
                fstack: [this.fstack.at(-1).concat([x, code])],
                var_dict: {},
            }) ?? null
        },
    }
    await what.eval_what(code, {
        fstack: [[]],
        builtins,
        var_dict: {},
        output: x => void output.push(h.text(x)),
        dead_loop_check,
    })
        .finally(() => disp())
    return output
}
const try_run_what = async (code: string, session: Session, ctx: Context) => {
    try {return await run_what(code, session, ctx)}
    catch (e) {const m = what.is_what_value(e) ? what.to_string(e) : String(e); ctx.logger.debug("%s", m); return h.text(m)}
}


export function apply(ctx: Context, config: Config) {
    ctx.model.extend("whatnoter", {
        uid: "unsigned(4)",
        public: "text",
        protected: "text",
        private: "text",
    }, {primary: "uid"})
    ctx.model.extend("whattimer", {
        name: "string",
        time: "unsigned",
        code: "text",
    }, {primary: "name"})
    ctx.model.extend("whatcommands", {
        name: "string",
        help: "text",
        h: "text",
        code: "text",
    }, {primary: "name"})

    //yes I stole it from waifu shut up
    ctx.guild().on('message-created', async (session) => {
        if (!session.userId) return
        const member : Universal.GuildMember = session.event.member || { user: session.event.user }
        await ctx.cache.set(`whatlang_members_${session.gid}`, session.userId, member, 172800000)
    })
    ctx.on('guild-member-removed', (session) => {
        if (!session.userId) return
        ctx.cache.delete(`whatlang_members_${session.gid}`, session.userId)
    })

    ctx.command("whatlang <code:text>", { strictOptions: true, captureQuote: false })
        .action(({ session }, code) => {
            if (!code && session.quote) code = h.unescape(session.quote.content)
            if (!code) return
            ctx.emit(session, "whatlang/run", code, session)
            return try_run_what(code, session, ctx)
        })
    ctx.command("whatcmd <name> <arg:text>", { strictOptions: true, captureQuote: false })
        .action(({ root, session }, name, arg) => {
            name ||= ""
            arg ||= ""
            if (root === true && session.quote?.content) {
                if (arg) arg += "\f"
                arg += "\f" + h.unescape(session.quote.content)
            }
            const code = `"${arg.replace(/(["\\])/g, "\\$1")}" "${name.replace(/(["\\])/g, "\\$1")}" cmd@`
            ctx.emit(session, "whatlang/run", code, session)
            return try_run_what(code, session, ctx)
        })

    ctx.i18n.define("zh-CN", "commands", {
        whatlang: {
            description: "运行 WhatLang 代码",
            usage: "快捷方式：¿(code...)\n使用 ¿help@. 获取帮助",
        },
        whatcmd: {
            description: "调用 WhatCommands 指令",
            usage: "快捷方式：¿¿(name) (arg...)",
        },
    })

    ctx.middleware(async (session, next) => {
        if (session.stripped.hasAt && !session.stripped.atSelf) return next()
        if (!session.isDirect && session.resolve(config.requireAppel) && !session.stripped.appel) return next()
        let content = h.unescape(session.stripped.content)
        if (content.startsWith("¿¿")) {
            let wcmd = content.slice(2)
            let space_pos = wcmd.match(/\s/)?.index ?? wcmd.length
            let arg = wcmd.slice(1 + space_pos)
            let name = wcmd.slice(0, space_pos)
            let argv = Argv.parse(`whatcmd `)
            argv.tokens.push({ inters: [], content: name, quoted: true, terminator: " " })
            // Workaround for https://github.com/koishijs/koishi/issues/1473
            argv.tokens.push({ inters: [], content: "", quoted: true, terminator: "" })
            argv.tokens.push(...Argv.parse(h.escape(arg)).tokens.map(token => ({ ...token, quoted: true })))
            if (session.quote?.content) {
                if (argv.tokens.length > 3) argv.tokens.at(-1).terminator += "\f"
                argv.tokens.push({ inters: [], content: session.quote.content, quoted: true, terminator: "" })
            }
            return session.execute(argv)
        } else if (content.startsWith("¿")) {
            ctx.emit(session, "whatlang/run", content.slice(1), session)
            return await try_run_what(content.slice(1), session, ctx)
        }
        return next()
    })

    if (config.interpolate) {
        Argv.interpolate('$¿{', '}', (raw) => {
            ctx.logger.debug("interpolate", raw)
            let i = -1, level = 0, parenLevel = 0, dblQuote = false
            while (++i < raw.length - 1) {
                let c = raw[i]
                if (!parenLevel && !dblQuote && c === "{") {
                    level++
                } else if (!parenLevel && !dblQuote && c === "}") {
                    if (!level) break
                    level--
                } else if (!dblQuote && c === "(") {
                    parenLevel++
                } else if (parenLevel && !dblQuote && c === ")") {
                    parenLevel--
                } else if (!parenLevel && c === '"') {
                    dblQuote = !dblQuote
                } else if (!parenLevel && c === "'") {
                    i++
                }
            }
            const source = raw.slice(0, i)

            return {
                source,
                command: ctx.command("whatlang"),
                args: [h.unescape(source)],
                rest: raw.slice(i + 1),
            }
        })
    }

    if (config.interpolateCmd) {
        Argv.interpolate('$¿(', ')', (raw) => {
            ctx.logger.debug("interpolateCmd", raw)
            const i = raw.indexOf(")")
            const source = raw.slice(0, i)
            const unescapedSource = h.unescape(source)
            const cmdName = unescapedSource.split(" ")[0]
            const cmdArgs = unescapedSource.slice(cmdName.length + 1)

            return {
                source,
                command: ctx.command("whatcmd"),
                args: [cmdName, cmdArgs],
                rest: raw.slice(i + 1),
            }
        })
    }
}
