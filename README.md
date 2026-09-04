# Culprit — demo site

This branch is the **[live demo](https://olayzen.github.io/culprit/)** of
[Culprit](https://github.com/OlaYZen/culprit): the real dashboard, running in
your browser on a recording of a real five-machine fleet. There is no backend
and nothing leaves the page. Every few minutes an ffmpeg transcode saturates
one node — watch the Lag Doctor name it, end it from the process dialog, and
read the verdict. Actions are simulated, and the banner says so.

It is published straight from this branch by GitHub Pages (Settings › Pages ›
Source: *Deploy from a branch*, branch `demo`, folder `/`). The code that
runs the product lives on `main`; nothing here is meant to be merged back.

## What is in here

| Path | What |
| --- | --- |
| `index.html`, `favicon.svg` | The page Pages serves. `index.html` is main's, with asset paths made relative and one extra module loaded before `app.js`. |
| `assets/css`, `assets/js` | A verbatim copy of `web/` from `main` — the same CSS and JS a real host serves, so what you try here is what you would install. |
| `assets/js/demo/` | The in-browser stand-in for the host. It replaces `fetch` for `/api/*` and `EventSource`, answers every route the views call with the host's own shapes, keeps the fleet alive (numbers wander, history grows, one agent is offline), runs the scripted incident, and judges your actions the way the host's verdict watch would. |
| `assets/demo/data/` | The recording: five nodes with their full snapshots and 53 hours of history, scrubbed (hosts and users renamed, public addresses moved to documentation ranges, MACs and machine ids hashed). |
| `tools/record_demo.py` | Records and scrubs a new set of fixtures from any host you can sign in to. Standard library only. |
| `tools/build_demo.py` | Refreshes `assets/` and `index.html` from `main` (or any ref) while keeping the demo module and data. |

## Refreshing the demo

```bash
git checkout demo
python3 tools/build_demo.py                # pull web/ from main, rewrite index.html
python3 -m http.server 8080                # try it: http://localhost:8080/
git commit -am "chore(demo): refresh from main"
git push
```

To re-record the data from your own fleet (read the output before you commit
it — a journal line can hold anything):

```bash
python3 tools/record_demo.py --url http://host:8787 --user me --password ... \
    --rename OldNode=media --alias myuser=sam --replace mydomain.tld=example.com
```
