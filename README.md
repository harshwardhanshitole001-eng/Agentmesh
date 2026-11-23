 # AgentMesh

Discovery playground and cross-site orchestrator for the open agentic web.
Paste any site URL: AgentMesh finds its `.network.json`, scores it, draws its tools on a live graph and lets a model chain tools across sites.

Full stack, **zero npm dependencies** (Node 18+).

  ## Run

```bash
npm start
```

Then open <http://localhost:3000>.

 ## What each part does

| Part | File | Role |
| --- | --- | --- |
| Manifest | `manifest.template.json` | Served at `/.network.json`, `/agent-manifest.json` and `/.well-known/*` with the correct origin injected |
| Browser runtime | `public/index.html` | Scanner, D3 graph, tool inspector, BYOK panel, agent loop, `postMessage` bridge |
| Backend | `server.js` | CORS relay scanner, SSRF-guarded tool relay, manifest validator, public registry, rate limit |

 ## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/scan?url=` | Fetch a remote manifest server-side (bypasses CORS) |
| POST | `/api/validate` | Score a manifest `{manifest}` from 0 to 100 |
| POST | `/api/registry` | Add a site `{url}`; the server re-fetches it, so entries cannot be faked |
| GET | `/api/registry` | List registered agents |
| POST | `/api/relay` | Relay a tool call `{url, body}` to a site without CORS |
| POST | `/api/tools/{scan_url,validate_manifest,list_agents}` | AgentMesh's own tools, callable by other agents |
| GET | `/api/health` | Status |

 ## Bring your own key

Open the model panel and choose OpenAI, OpenRouter, or Mozilla Otari (paste your router's OpenAI-compatible base URL). Keys stay in the browser and go only to the endpoint you set.

 ## Deploy

- **Render / Railway / Fly**: connect the repo, start command `node server.js`.
- **Docker**: `docker build -t agentmesh . && docker run -p 3000:3000 agentmesh`.
- Static-only hosting (GitHub Pages) works for the UI: open it with `?api=https://your-backend` to use a separately hosted backend.

Environment: `PORT` (default 3000). `ALLOW_PRIVATE=1` disables the private-address block, for local testing only.

 ## Make your own site discoverable

Host a `.network.json` with `name`, `description`, `url` and `tools[]` (each with `description`, `inputSchema`, `endpoint`), and send `Access-Control-Allow-Origin: *`.

 ## License

MIT
