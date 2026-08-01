# Putting this online

Two different jobs, and they need different setups. Doing the second one on the
first one's infrastructure is how a client loses orders.

---

## 1. A demo link you can send to anyone

Free, five minutes, no card.

### Render (easiest — the repo already has the blueprint)

1. [render.com](https://render.com) → sign in with GitHub
2. **New → Blueprint** → pick this repo
3. Render reads `render.yaml` and creates the service
4. You get **`https://ethnic-commerce-demo.onrender.com`** (rename the service to
   change that first part)

Send that link. The storefront works fully — browse, filter, add to bag, check a
pincode, walk the whole checkout, place an order, download the GST invoice.

Admin is at `/admin`. On a fresh deploy the first visit offers a one-time owner
setup, so pick an email and password there — it is never briefly open to whoever
finds it.

**Two things to know before you show it:**

- **A free service sleeps after ~15 minutes idle** and takes ~50 seconds to wake.
  Open the link yourself a minute before a client does, or the first impression is
  a spinner.
- **The disk is ephemeral.** Orders and product edits made on the demo vanish on
  the next restart, and the committed demo catalogue comes back. That is right for
  a demo you want to look the same every time, and wrong for a real shop.

### Alternatives

| Host | Notes |
|---|---|
| **Railway** | Same idea, no blueprint needed — it detects Node and runs `npm start`. Free trial credit rather than a permanent free tier. |
| **Fly.io** | Free allowance, and a real persistent volume even on the small plans. More setup (`fly launch`). |
| **Vercel** | Works, but the filesystem is read-only per request — anything the admin writes fails. Fine for showing the storefront, not the admin. |

**GitHub Pages will not work.** This is a Node server, not static files.

---

## 2. A real client store

The difference is one thing: **the data has to survive a restart.**

### Render, paid instance

1. Create the service as above, on a **Starter** plan or higher
2. Add a **Disk**: mount path `/data`, 1 GB is plenty
3. Set environment variables:

```
NODE_ENV=production
DATA_DIR=/data
```

That is all — `src/store.js` and the catalogue both read `DATA_DIR`, so the store
writes to the persistent disk instead of the container.

4. Add the client's domain under **Settings → Custom Domains**, and point their DNS
   at it. Render issues the TLS certificate.

### A VPS (Hetzner, DigitalOcean, an Indian provider)

```bash
git clone https://github.com/Gasm2005/Ecommerce.git store && cd store
npm install
npm run doctor          # tells you what is not ready
pm2 start ecosystem.config.js
pm2 save
```

`ecosystem.config.js` pins pm2 to **one worker**, and the server refuses to boot as
worker #1 or higher. That is not a limitation to work around — the store keeps a
per-process read cache, so a second worker writes from a stale copy and silently
loses orders. A store that loses one order in fifty is worse than one that will not
start.

Then put nginx or Caddy in front for TLS.

---

## Before handing a link to a paying client

```bash
npm run doctor
```

It fails the launch — exit code 1 — on anything that would embarrass you:

- the brand is still the demo one
- GSTIN or business address missing, so invoices are not valid
- Razorpay still in **test** mode (real cards would not be charged)
- email provider still `log`, so order confirmations go to the console
- a handover password still in use
- `ADMIN_TOKEN` still set — it bypasses the login entirely
- pm2 configured for more than one worker
- the licence **signing key** present on the server (that file can mint licences
  for every store you have ever sold — it belongs on your machine only)

And it warns on things worth a look: no backup in the last 7 days, products still
using placeholder art, a licence that is not domain-locked.

---

## Backups

```bash
npm run backup
```

Every admin write already takes a timestamped backup into `data/backups/`. Schedule
the command daily (cron, or Task Scheduler on Windows) and copy the folder
somewhere off the machine — a backup on the same disk as the thing it is backing up
is not a backup.
