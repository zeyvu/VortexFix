#!/usr/bin/env node
/**
 * Patches Vortex app.asar DIRECTLY (without extracting or repacking).
 *
 *  renderer.js (UI)
 *    1. "View page" in collections opens the internal browser.
 *    2. The "Download" button in the free-user dialog does the same.
 *    3. Internal browser: editable address bar + Reload button +
 *       extension and userscript manager (icons and panel with puzzle button).
 *    4. Internal browser: removes the preliminary "Continue" warning screen.
 *
 *  main.cjs (main process)
 *    5. Loads unpacked Chrome extensions from
 *         %APPDATA%\Vortex\browser-extensions\<name>\manifest.json
 *       and USERSCRIPTS (Tampermonkey-style) from
 *         %APPDATA%\Vortex\userscripts\*.user.js
 *       Logs are written to _status.log inside each folder.
 *
 * Usage: node patch-vortex.js "C:\Program Files\Vortex\resources\app.asar"
 * Fully close Vortex first. Creates app.asar.bak the first time and ALWAYS
 * starts from that backup (safe to run multiple times). After updating Vortex:
 * delete the .bak file.
 */
const fs = require("fs");
const crypto = require("crypto");

/* ======================================================================
 *  CODE INJECTED INTO VORTEX
 *  (these are actual functions: the patch uses their text via .toString())
 * ====================================================================== */

// ---- Main process: extensions + userscripts + IPC ----
function MAIN_INJECT() {
  try {
    const E = require("electron"), fs = require("fs"), path = require("path"), crypto = require("crypto");
    const base = E.app.getPath("userData");
    const dir = path.join(base, "browser-extensions"), udir = path.join(base, "userscripts");
    const mkLog = f => m => { try { fs.appendFileSync(f, new Date().toISOString() + " " + m + "\n"); } catch (_) {} };
    fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(udir, { recursive: true });
    const logf = path.join(dir, "_status.log"), ulogf = path.join(udir, "_status.log");
    try { fs.writeFileSync(logf, ""); } catch (_) {}
    try { fs.writeFileSync(ulogf, ""); } catch (_) {}
    const log = mkLog(logf), ulog = mkLog(ulogf);
    const ses = E.session.fromPartition("persist:webview"), mgr = ses.extensions || ses;

    // ---------- Chrome extensions ----------
    let n = 0;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (!fs.existsSync(path.join(p, "manifest.json"))) continue;
      n++;
      mgr.loadExtension(p, { allowFileAccess: true }).then(
        x => log("OK " + x.name + " " + x.version + " (" + name + ")"),
        err => log("FAILED " + name + ": " + (err && err.message || err)));
    }
    log("Folder: " + dir + " ; extensions found: " + n);

    const info = x => {
      const m = x.manifest || {}, act = m.action || m.browser_action || {};
      let icon = null;
      try {
        const ic = act.default_icon, i0 = (ic && ("string" == typeof ic ? ic : Object.values(ic).pop())) || (m.icons && Object.values(m.icons).pop());
        if (i0) {
          const f = path.join(x.path, i0), e = path.extname(f).slice(1).toLowerCase();
          icon = "data:" + ("svg" === e ? "image/svg+xml" : "image/" + ("jpg" === e ? "jpeg" : e)) + ";base64," + fs.readFileSync(f).toString("base64");
        }
      } catch (_) {}
      return { id: x.id, name: x.name, version: x.version, description: m.description || "", icon: icon,
        popup: act.default_popup || null, options: m.options_page || m.options_ui && m.options_ui.page || null };
    };
    const h = (c, f) => { try { E.ipcMain.removeHandler(c); } catch (_) {} E.ipcMain.handle(c, f); };
    h("vx-ext-list", () => mgr.getAllExtensions().map(info));
    h("vx-ext-open", (ev, id, page, kind) => {
      try {
        const x = mgr.getExtension(id), rel = String(page || "").replace(/^\/+/, "");
        if (!x || !rel || /^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.split(/[\\/]/).includes("..")) return false;
        const pop = "popup" === kind;
        const w = new E.BrowserWindow({ width: pop ? 420 : 1000, height: pop ? 640 : 760, title: x.name, autoHideMenuBar: true, webPreferences: { session: ses } });
        w.webContents.setWindowOpenHandler(({ url }) => (/^https?:/i.test(url) && E.shell.openExternal(url), { action: "deny" }));
        w.loadURL(x.url.replace(/\/*$/, "/") + rel);
        return true;
      } catch (e) { log("OPEN failed: " + (e && e.message || e)); return false; }
    });
    h("vx-ext-remove", async (ev, id) => {
      try {
        const x = mgr.getExtension(id); if (!x) return false;
        const p = x.path; await mgr.removeExtension(id);
        path.resolve(path.dirname(p)) === path.resolve(dir) && await E.shell.trashItem(p);
        log("REMOVED " + x.name); return true;
      } catch (e) { log("REMOVE failed: " + (e && e.message || e)); return false; }
    });
    h("vx-ext-folder", () => E.shell.openPath(dir));

    // ---------- Userscripts (Tampermonkey-style) ----------
    const DIS = path.join(udir, "_disabled.json");
    const readDis = () => { try { return JSON.parse(fs.readFileSync(DIS, "utf8")); } catch (_) { return []; } };
    const UNSUPPORTED = /\b(GM_download|GM\.download|GM_notification|GM\.notification|GM_getResourceText|GM_getResourceURL|GM\.getResourceUrl|GM_addValueChangeListener|GM_removeValueChangeListener|GM_cookie|GM_getTab|GM_saveTab)\b/;
    const parseMeta = src => {
      const m = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/.exec(src);
      if (!m) return null;
      const meta = {};
      for (const line of m[1].split(/\r?\n/)) {
        const r = /^\s*\/\/\s*@([\w:-]+)(?:\s+(.*?))?\s*$/.exec(line);
        if (!r) continue;
        (meta[r[1]] = meta[r[1]] || []).push(r[2] === undefined ? "" : r[2]);
      }
      return meta;
    };
    const globRe = s => new RegExp("^" + s.replace(/[.+?^$|(){}\[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
    const incMatch = (pat, url) => {
      try {
        const r = /^\/(.*)\/([a-z]*)$/.exec(pat);
        return r ? new RegExp(r[1], r[2]).test(url) : globRe(pat).test(url);
      } catch (_) { return false; }
    };
    const matchPat = (pat, url) => {
      if (pat === "<all_urls>") return /^https?:/i.test(url);
      const m = /^(\*|https?):\/\/([^\/]*)(\/.*)$/.exec(pat);
      if (!m) return false;
      let u; try { u = new URL(url); } catch (_) { return false; }
      const sch = u.protocol.slice(0, -1);
      if (sch !== "http" && sch !== "https") return false;
      if (m[1] !== "*" && m[1] !== sch) return false;
      const hp = m[2].toLowerCase(), hn = u.hostname.toLowerCase();
      if (hp !== "*") {
        if (hp.startsWith("*.")) { const b = hp.slice(2); if (hn !== b && !hn.endsWith("." + b)) return false; }
        else if (hp !== hn && hp !== u.host.toLowerCase()) return false;
      }
      return globRe(m[3]).test(u.pathname + u.search);
    };
    const shouldRun = (meta, url) => {
      const mt = meta.match || [], inc = meta.include || [];
      if (!mt.length && !inc.length) return false;
      if (!(mt.some(p => matchPat(p, url)) || inc.some(p => incMatch(p, url)))) return false;
      return !((meta.exclude || []).some(p => incMatch(p, url)) || (meta["exclude-match"] || []).some(p => matchPat(p, url)));
    };
    const listUS = () => {
      let names = []; try { names = fs.readdirSync(udir); } catch (_) {}
      const dis = readDis();
      return names.filter(f => /\.user\.js$/i.test(f)).map(f => {
        let src = ""; try { src = fs.readFileSync(path.join(udir, f), "utf8"); } catch (_) {}
        const meta = parseMeta(src), w = [];
        if (!meta) w.push("missing ==UserScript== header");
        else {
          if (!(meta.match || []).length && !(meta.include || []).length) w.push("missing @match/@include: script will not run");
          if ((meta.resource || []).length) w.push("@resource is not supported");
        }
        const un = UNSUPPORTED.exec(src); if (un) w.push("uses " + un[1] + " (not supported)");
        return { file: f, src: src, meta: meta, disabled: dis.includes(f), warnings: w };
      });
    };
    const first = (m, k) => (m && m[k] || [""])[0];
    const when = f => { const ra = (first(f.meta, "run-at") || "document-idle").trim(); return ra === "document-idle" ? "idle" : "early"; };

    // GM_* environment exposed to the script (serialized and executed in the page)
    function gmRuntime(info) {
      const P = "__vxus:" + info.id + ":", ls = window.localStorage;
      const GM_getValue = (k, d) => { try { const v = ls.getItem(P + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
      const GM_setValue = (k, v) => { try { ls.setItem(P + k, JSON.stringify(v)); } catch (e) {} };
      const GM_deleteValue = k => { try { ls.removeItem(P + k); } catch (e) {} };
      const GM_listValues = () => { const o = []; try { for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k.startsWith(P)) o.push(k.slice(P.length)); } } catch (e) {} return o; };
      const GM_addStyle = css => {
        const s = document.createElement("style"); s.textContent = css;
        (document.head || document.documentElement).appendChild(s);
        // If the website's CSP blocks inline <style>, the stylesheet is not created:
        // use a constructed stylesheet (exempt from CSP)
        if (!s.sheet) { try { const sh = new CSSStyleSheet(); sh.replaceSync(css); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sh]; } catch (e) {} }
        return s;
      };
      const GM_log = (...a) => console.log("[" + info.name + "]", ...a);
      const GM_setClipboard = t => { try { navigator.clipboard.writeText(String(t)); } catch (e) {} };
      const GM_openInTab = u => { window.open(u, "_blank"); };
      const GM_registerMenuCommand = () => {};
      const GM_xmlhttpRequest = d => {
        const ctl = new AbortController(); let t;
        const o = { method: d.method || "GET", headers: d.headers || {}, signal: ctl.signal, credentials: d.anonymous ? "omit" : "include" };
        if (d.data !== undefined && o.method !== "GET" && o.method !== "HEAD") o.body = d.data;
        if (d.timeout) t = setTimeout(() => { ctl.abort(); d.ontimeout && d.ontimeout({}); }, d.timeout);
        fetch(d.url, o).then(async r => {
          clearTimeout(t);
          const rt = d.responseType;
          const body = rt === "arraybuffer" ? await r.arrayBuffer() : rt === "blob" ? await r.blob() : await r.text();
          const res = { status: r.status, statusText: r.statusText, finalUrl: r.url,
            responseHeaders: Array.from(r.headers).map(p => p[0] + ": " + p[1]).join("\r\n"),
            response: rt === "json" ? JSON.parse(body) : body, responseText: typeof body === "string" ? body : "" };
          d.onload && d.onload(res);
        }).catch(e => { clearTimeout(t); d.onerror && d.onerror({ error: String(e && e.message || e) }); });
        return { abort: () => ctl.abort() };
      };
      const GM = { info: info, getValue: async (k, d) => GM_getValue(k, d), setValue: async (k, v) => GM_setValue(k, v),
        deleteValue: async k => GM_deleteValue(k), listValues: async () => GM_listValues(), addStyle: async c => GM_addStyle(c),
        log: GM_log, setClipboard: GM_setClipboard, openInTab: GM_openInTab, registerMenuCommand: GM_registerMenuCommand,
        xmlHttpRequest: d => new Promise((ok, ko) => GM_xmlhttpRequest(Object.assign({}, d, { onload: ok, onerror: ko, ontimeout: ko }))) };
      return { GM_info: info, GM_getValue, GM_setValue, GM_deleteValue, GM_listValues, GM_addStyle, GM_log, GM_setClipboard,
        GM_openInTab, GM_registerMenuCommand, GM_xmlhttpRequest, GM, unsafeWindow: window };
    }

    const getReq = async u => {
      if (!/^https:\/\//i.test(u)) throw new Error("@require only supports https: " + u);
      const c = path.join(udir, "_cache"); fs.mkdirSync(c, { recursive: true });
      const f = path.join(c, crypto.createHash("sha1").update(u).digest("hex") + ".js");
      try { return fs.readFileSync(f, "utf8"); } catch (_) {}
      const r = await E.net.fetch(u);
      if (!r.ok) throw new Error("HTTP " + r.status + " while downloading " + u);
      const t = await r.text();
      if (t.length > 3e6) throw new Error("@require is too large: " + u);
      fs.writeFileSync(f, t); return t;
    };
    const build = async f => {
      const m = f.meta;
      const meta = { id: crypto.createHash("sha1").update(f.file).digest("hex").slice(0, 10), name: first(m, "name") || f.file,
        version: first(m, "version"), description: first(m, "description"), namespace: first(m, "namespace"),
        matches: (m.match || []).concat(m.include || []) };
      let reqs = "";
      for (const u of m.require || []) reqs += (await getReq(u.split("#")[0])) + "\n;\n";
      return "(function(){const __a=(" + gmRuntime.toString() + ")(" + JSON.stringify({ id: meta.id, name: meta.name, script: meta }) +
        ");const {GM_info,GM_getValue,GM_setValue,GM_deleteValue,GM_listValues,GM_addStyle,GM_log,GM_setClipboard,GM_openInTab,GM_registerMenuCommand,GM_xmlhttpRequest,GM,unsafeWindow}=__a;" +
        "try{(function(){\n" + reqs + f.src + "\n}).call(window)}catch(e){console.error('[userscript]'," + JSON.stringify(meta.name) + ",e)}})()";
    };

    listUS().forEach(f => f.warnings.forEach(w => ulog("WARNING " + f.file + ": " + w)));
    ulog("Folder: " + udir + " ; userscripts found: " + listUS().length);

    h("vx-us-list", () => listUS().map(f => ({ file: f.file, name: f.meta ? first(f.meta, "name") || f.file : f.file,
      version: first(f.meta, "version"), description: first(f.meta, "description"),
      matches: f.meta ? (f.meta.match || []).concat(f.meta.include || []) : [], enabled: !f.disabled, warnings: f.warnings })));
    h("vx-us-toggle", (ev, file) => {
      if (!listUS().some(f => f.file === file)) return false;
      const d = readDis(), i = d.indexOf(file);
      i >= 0 ? d.splice(i, 1) : d.push(file);
      fs.writeFileSync(DIS, JSON.stringify(d)); return true;
    });
    h("vx-us-folder", () => E.shell.openPath(udir));

    if (!E.app.__vxUS) {
      E.app.__vxUS = true;
      E.app.on("web-contents-created", (ev, wc) => {
        if ("webview" !== wc.getType()) return;
        // Vortex only uses <webview> for its internal browser: always attach,
        // and report if the session is not the expected one.
        ulog("webview detected; session " + (wc.session === ses ? "correct (persist:webview)" : "DIFFERENT from persist:webview (hooking anyway)"));
        const run = w => async () => {
          try {
            const url = wc.getURL();
            const act = listUS().filter(f => !f.disabled && f.meta && when(f) === w);
            const ok = act.filter(f => shouldRun(f.meta, url));
            ulog("event " + ("early" === w ? "dom-ready" : "did-finish-load") + " url=" + url + " ; active scripts for this phase=" + act.length + " ; matches=" + ok.length);
            if (!/^https?:/i.test(url)) return;
            for (const f of ok) {
              try { await wc.executeJavaScript(await build(f), true); ulog("INJECTED " + f.file); }
              catch (e) { ulog("FAILED " + f.file + ": " + (e && e.message || e)); }
            }
          } catch (e) { ulog("Internal error: " + (e && e.message || e)); }
        };
        wc.on("dom-ready", run("early"));
        wc.on("did-finish-load", run("idle"));
      });
    }
  } catch (e) {}
}

// ---- UI: extension icons + panel (extensions and userscripts) ----
function RENDERER_EXT(React, require) {
  const IR = require("electron").ipcRenderer, h = React.createElement;
  const B = { background: "transparent", border: "1px solid transparent", color: "inherit", cursor: "pointer", padding: "2px 6px", borderRadius: "4px" };
  const T = { fontWeight: "bold", margin: "8px 0 4px", borderBottom: "1px solid #666" };
  class P extends React.Component {
    constructor(p) { super(p); this.state = { list: [], us: [], open: false, err: null }; }
    componentDidMount() { this.refresh(); }
    refresh = () => {
      Promise.all([IR.invoke("vx-ext-list"), IR.invoke("vx-us-list")]).then(
        r => this.setState({ list: r[0] || [], us: r[1] || [], err: null }),
        e => this.setState({ err: String(e && e.message || e) }));
    };
    go = (x, k) => { const pg = k === "popup" ? x.popup : x.options; pg && IR.invoke("vx-ext-open", x.id, pg, k); };
    del = x => { window.confirm("Remove " + x.name + "? Its folder will be moved to the Recycle Bin.") && IR.invoke("vx-ext-remove", x.id).then(this.refresh); };
    tog = u => { IR.invoke("vx-us-toggle", u.file).then(this.refresh); };
    render() {
      const s = this.state, L = s.list, U = s.us;
      return h("div", { style: { display: "flex", alignItems: "center", position: "relative" } },
        L.map(x => h("button", { key: x.id, title: x.name + (x.popup ? "" : x.options ? " (settings)" : ""), style: B,
          disabled: !(x.popup || x.options), onClick: () => this.go(x, x.popup ? "popup" : "options") },
          x.icon ? h("img", { src: x.icon, width: 18, height: 18 }) : h("span", null, (x.name || "?").charAt(0).toUpperCase()))),
        h("button", { title: "Extensions and userscripts", style: B, onClick: () => { this.setState({ open: !s.open }); s.open || this.refresh(); } }, "\u{1F9E9}"),
        s.open && h("div", { style: { position: "absolute", right: 0, top: "100%", zIndex: 2000, minWidth: "360px", maxHeight: "60vh", overflowY: "auto",
          padding: "8px", background: "#2b2b2b", color: "#eee", border: "1px solid #666", borderRadius: "6px", boxShadow: "0 4px 16px rgba(0,0,0,.5)" } },
          s.err ? h("div", null, "Error: " + s.err) : null,
          h("div", { style: T }, "Extensions"),
          !s.err && 0 === L.length ? h("div", { style: { opacity: .7 } }, "None loaded. Copy unpacked extension folders into the extensions folder and restart Vortex.") : null,
          L.map(x => h("div", { key: x.id, style: { padding: "6px 0", borderBottom: "1px solid #444" } },
            h("div", { style: { fontWeight: "bold" } }, x.name + " " + x.version),
            x.description ? h("div", { style: { fontSize: "11px", opacity: .7 } }, x.description) : null,
            h("div", { style: { marginTop: "4px" } },
              x.options ? h("button", { style: B, onClick: () => this.go(x, "options") }, "Settings") : null,
              x.popup ? h("button", { style: B, onClick: () => this.go(x, "popup") }, "Popup") : null,
              h("button", { style: B, onClick: () => this.del(x) }, "Remove")))),
          h("div", { style: T }, "Userscripts"),
          !s.err && 0 === U.length ? h("div", { style: { opacity: .7 } }, "None. Copy .user.js files into the scripts folder; they are applied when the page is reloaded.") : null,
          U.map(u => h("div", { key: u.file, style: { padding: "6px 0", borderBottom: "1px solid #444" } },
            h("div", { style: { fontWeight: "bold", opacity: u.enabled ? 1 : .5 } }, u.name + (u.version ? " " + u.version : "")),
            u.description ? h("div", { style: { fontSize: "11px", opacity: .7 } }, u.description) : null,
            h("div", { style: { fontSize: "11px", opacity: .7 } }, u.matches.length ? "On: " + u.matches.slice(0, 2).join(", ") + (u.matches.length > 2 ? " ..." : "") : "(no @match)"),
            u.warnings.map((w, i) => h("div", { key: i, style: { fontSize: "11px", color: "#e0a030" } }, "\u26A0 " + w)),
            h("div", { style: { marginTop: "4px" } }, h("button", { style: B, onClick: () => this.tog(u) }, u.enabled ? "Disable" : "Enable")))),
          h("div", { style: { marginTop: "6px" } },
            h("button", { style: B, onClick: () => IR.invoke("vx-ext-folder") }, "Extensions folder"),
            h("button", { style: B, onClick: () => IR.invoke("vx-us-folder") }, "Scripts folder"),
            h("button", { style: B, onClick: this.refresh }, "Refresh"))));
    }
  }
  return P;
}

/* ======================================================================
 *  PATCHES
 * ====================================================================== */
const target = process.argv[2];
if (require.main === module) {
  if (!target) { console.error("Missing app.asar path"); process.exit(1); }
}
const bak = target + ".bak";
const out = target + ".tmp";

const INSTR = "Vortex internal browser omg !! also, dont pay attention to the one down me, really.";

const PATCHES = {
  "renderer.js": [
    {
      name: "1. View page -> internal browser",
      from: "onViewPage:()=>window.api.shell.openUrl(`https://www.nexusmods.com/games/${collection.game.domainName}/collections/${collection.slug}`)",
      to: "onViewPage:()=>api.emitAndAwait(\"browse-for-download\",`https://www.nexusmods.com/games/${collection.game.domainName}/collections/${collection.slug}`,\"" + INSTR + "\").then(r=>{const raw=(r||[]).find(Boolean);raw&&!String(raw).startsWith(\"err:\")&&api.events.emit(\"start-download-url\",raw)}).catch(()=>null)"
    },
    {
      name: "2. Free-user Download button -> internal browser",
      from: "(0,opn_1.default)(`${constants_2.NEXUS_BASE_URL}/${url.gameId}/mods/${url.modId}?tab=files&file_id=${url.fileId}&nmm=1`).catch(()=>null)",
      to: "this.#api.emitAndAwait(\"browse-for-download\",`${constants_2.NEXUS_BASE_URL}/${url.gameId}/mods/${url.modId}?tab=files&file_id=${url.fileId}&nmm=1`,\"" + INSTR + "\").catch(()=>null)"
    },
    {
      name: "3. Address bar + Reload + extension and userscript manager",
      from: String.raw`tooltip:t("Forward")}))}renderUrl(input){if(!(0,util_1.truthy)(input))return null;`,
      to: String.raw`tooltip:t("Forward")}),React.createElement(TooltipControls_1.IconButton,{icon:"refresh",onClick:this.reloadPage,tooltip:t("Reload")}))}reloadPage=()=>{try{this.mWebView&&this.mWebView.reload()}catch(err){}};vxExt=(` + RENDERER_EXT.toString() + String.raw`)(React,require);renderAddressBar(input){return React.createElement("div",{style:{display:"flex",flex:"1 1 auto",alignItems:"center",minWidth:0}},React.createElement("input",{key:input,type:"text",defaultValue:input,spellCheck:!1,title:"Enter an address and press Enter",style:{flex:"1 1 auto",minWidth:"220px",margin:"0 8px",padding:"4px 8px",borderRadius:"4px",border:"1px solid rgba(128,128,128,0.6)",background:"rgba(0,0,0,0.25)",color:"inherit"},onFocus:e=>e.target.select(),onKeyDown:e=>{if("Enter"!==e.key)return;let v=e.target.value.trim();if(!v)return;if(/^(javascript|data|vbscript|file|blob):/i.test(v))return;/^[a-z][a-z0-9+.-]*:\/\//i.test(v)||(v="https://"+v);this.addToHistory(v);try{this.mRef.loadURL(v)}catch(err){}}}),React.createElement(this.vxExt))}renderUrl(input){if(!(0,util_1.truthy)(input))return null;return this.renderAddressBar(input);`
    },
    {
      name: "4. Remove the browser's preliminary warning screen",
      from: "this.initState({confirmed:!1,loading:!1,url:props.url",
      to: "this.initState({confirmed:!0,loading:!1,url:props.url"
    }
  ],
  "main.cjs": [
    {
      name: "5. Chrome extensions + userscripts in the internal browser",
      from: "this.initEventHandlers(),new Promise(e=>{this.mWindow?.once(`ready-to-show`",
      to: "this.initEventHandlers(),(" + MAIN_INJECT.toString() + ")(),new Promise(e=>{this.mWindow?.once(`ready-to-show`"
    }
  ]
};

if (require.main === module) {
  if (!fs.existsSync(bak)) fs.copyFileSync(target, bak);
  const input = bak;

  // ================= ASAR READING =================
  const fd = fs.openSync(input, "r");
  const pre = Buffer.alloc(16); fs.readSync(fd, pre, 0, 16, 0);
  const hs = pre.readUInt32LE(4), jlen = pre.readUInt32LE(12);
  const base = 8 + hs;
  const hbuf = Buffer.alloc(jlen); fs.readSync(fd, hbuf, 0, jlen, 16);
  const header = JSON.parse(hbuf.toString("utf8"));
  const total = fs.fstatSync(fd).size;
  const dataLen = total - base;

  let cursor = dataLen;
  const appended = [];
  let applied = 0;

  for (const [fname, list] of Object.entries(PATCHES)) {
    const entry = header.files[fname];
    if (!entry) { console.log("SKIPPED file not found in asar:", fname); continue; }
    const raw = Buffer.alloc(entry.size);
    fs.readSync(fd, raw, 0, entry.size, base + Number(entry.offset));
    let js = raw.toString("utf8"), done = 0;
    for (const p of list) {
      const n = js.split(p.from).length - 1;
      if (n === 1) { js = js.replace(p.from, () => p.to); done++; console.log("OK     ", p.name); }
      else console.log("SKIPPED", p.name, `(matches: ${n}; this Vortex version does not match)`);
    }
    if (done === 0) continue;
    applied += done;
    const nb = Buffer.from(js, "utf8");
    const BS = (entry.integrity && entry.integrity.blockSize) || 4194304;
    const blocks = [];
    for (let i = 0; i < nb.length; i += BS) blocks.push(crypto.createHash("sha256").update(nb.subarray(i, i + BS)).digest("hex"));
    entry.offset = String(cursor);
    entry.size = nb.length;
    entry.integrity = { algorithm: "SHA256", hash: crypto.createHash("sha256").update(nb).digest("hex"), blockSize: BS, blocks };
    cursor += nb.length;
    appended.push(nb);
  }
  if (applied === 0) { console.error("Nothing to patch. No changes have been made."); process.exit(1); }

  // ================= WRITING =================
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const aligned = (json.length + 3) & ~3;
  const nh = Buffer.alloc(16 + aligned);
  nh.writeUInt32LE(4, 0); nh.writeUInt32LE(8 + aligned, 4);
  nh.writeUInt32LE(4 + aligned, 8); nh.writeUInt32LE(json.length, 12);
  json.copy(nh, 16);

  const wfd = fs.openSync(out, "w");
  fs.writeSync(wfd, nh);
  const chunk = Buffer.alloc(8 * 1024 * 1024);
  for (let pos = base; pos < total; ) {
    const len = Math.min(chunk.length, total - pos);
    fs.readSync(fd, chunk, 0, len, pos);
    fs.writeSync(wfd, chunk, 0, len); pos += len;
  }
  for (const b of appended) fs.writeSync(wfd, b);
  fs.closeSync(wfd); fs.closeSync(fd);

  try {
    fs.renameSync(out, target);
  } catch (err) {
    try { fs.unlinkSync(out); } catch (_) {}
    console.error("\nCould not replace app.asar (" + err.code + ").");
    console.error("Vortex is almost certainly still running and has the file open.");
    console.error("Fully close it (system tray > Exit) and check Task Manager");
    console.error("to make sure no 'Vortex.exe' process remains. Then run this script again.");
    console.error("(The temporary file has been deleted; your original app.asar has not been touched.)");
    process.exit(1);
  }
  console.log(`Done. ${applied} patch(es) applied. Original backup: ${bak}`);
}