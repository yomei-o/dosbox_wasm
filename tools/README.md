# tools

## `trace.html`

Startup tracer for `dosbox-x.wasm`.

When DOSBox-X hangs during startup the renderer stops pumping its message loop,
so `console.log` never reaches the devtools or a Playwright listener — the page
just looks dead. This page routes `Module.print` / `printErr` through a
**synchronous** `XMLHttpRequest` to `/LOG/<message>` instead, which still goes
out over the wire while the thread is blocked. The web server's access log
becomes the trace, and the last line before it stops is the call that hung.

```sh
cd <repo root>
python3 -u -m http.server 8795 --bind 127.0.0.1 > /tmp/httpd.log 2>&1 &
# open http://127.0.0.1:8795/tools/trace.html, wait, then:
grep -oE 'GET /LOG/[^ ]*' /tmp/httpd.log | sed 's|GET /LOG/||' |
  python3 -c 'import sys,urllib.parse; [print(urllib.parse.unquote(l.strip())) for l in sys.stdin]'
```

This is how the `SDL_InitSubSystem(SDL_INIT_JOYSTICK)` hang fixed in
`scripts/patch-dosbox-x.py` was found.
