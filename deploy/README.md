# Private VPS deployment with Coolify

This setup runs one Next.js server with Node 24 and a persistent SQLite volume. A Caddy gateway authenticates every request with HTTP Basic authentication. Coolify handles the public HTTPS certificate and routes traffic to that gateway. All connected devices use the same personal data; there are no separate user accounts.

## Configure the application

Create a Coolify **Docker Compose application from the Git repository**. Set **Base Directory** to `/` and **Docker Compose Location** to `/deploy/compose.coolify.yaml`. Leave **Raw Compose Deployment**, **Connect To Predefined Network**, and preview deployments disabled. This configuration requires Docker Compose 2.23.1 or newer for the embedded Caddy configuration.

Add a DNS A record for the chosen hostname, such as `defense.example.com`, pointing to the VPS. Add AAAA only if the server also has working IPv6. Keep other sites and their DNS records unchanged.

Set **Domains for gateway** to `https://defense.example.com` and enable **Force Https**. Leave **Domains for app** empty, removing any generated domain. Neither service publishes a host port. The existing Coolify proxy remains the only public entry point on ports 80 and 443.

In **Environment Variables**, set each value as a **Runtime Variable**, with **Build Variable** disabled. Also disable **Inject Build Args to Dockerfile**. Application source is built without local databases, `.env` files, or API keys.

| Variable                          | Value                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `APP_HOST`                        | `defense.example.com`, without a scheme, path, or trailing slash.                                                              |
| `APP_LOGIN`                       | Your personal login, without spaces.                                                                                           |
| `APP_PASSWORD_HASH`               | A bcrypt password hash generated below. In Coolify's Normal view, paste the hash alone and enable **Literal** to preserve `$`. |
| `APP_PROXY_SECRET`                | An independent random 64-character hexadecimal secret, generated below.                                                        |
| `DTM_COLLECTION_INTERVAL_MINUTES` | Minimum interval per source; `15` by default.                                                                                  |
| `TYPESAFE_API_KEY`                | Optional Jev key; empty disables paid classification.                                                                          |
| `DTM_JEV_MONTHLY_BUDGET_USD`      | Your chosen Jev monthly cap; `0` by default.                                                                                   |
| `OPENAI_API_KEY`                  | Optional OpenAI key; empty disables generated summaries.                                                                       |
| `DTM_SUMMARY_MONTHLY_BUDGET_USD`  | Your chosen summary monthly cap; `0` by default.                                                                               |
| `DTM_SUMMARY_MODEL`               | A supported model from the main README; copy your existing choice when migrating.                                              |

Keep the four `APP_*` access values configured at runtime. Compose can warn that runtime-only values are absent during a Coolify build; no service starts at that stage. Missing access configuration must be fixed before use. The application fails closed when deployment access settings are incomplete.

Generate the password hash interactively, keeping the password out of shell history:

```sh
docker run --rm -it caddy:2.11.4-alpine caddy hash-password --algorithm bcrypt
```

Generate a separate proxy secret:

```sh
openssl rand -hex 32
```

Save the password in your password manager. Save deployment secrets in Coolify, not Git. `APP_PROXY_SECRET` is supplied to both services; Compose maps it to `DTM_PROXY_SECRET` in the app. `APP_HOST` becomes `DTM_APP_ORIGIN=https://APP_HOST`. Local `.env.local` values are not uploaded automatically: copy only the runtime provider configuration you intend to retain. Keys and caps alone do not enable Jev mode or request a summary. A migrated database can retain an enabled Jev worker, collection schedule, and its spending ledger, so review them before starting it.

The gateway preserves Host and Origin, overwrites `X-Dtm-Proxy-Secret`, and removes Authorization before forwarding to Next.js. Responses use `Cache-Control: private, no-store`; request bodies are limited to 65,536 bytes. Keep the app private on its Docker network and route all browser traffic through the gateway.

## Validate and deploy

For local configuration validation, create a Git-ignored `deploy/.env` containing the table's variables. Use single quotes around a bcrypt hash in that file, and restrict its permissions with `chmod 600 deploy/.env`. From the repository root, reproduce Coolify's project directory:

```sh
docker compose --project-directory . --env-file deploy/.env -f deploy/compose.coolify.yaml config --quiet
docker compose --project-directory . --env-file deploy/.env -f deploy/compose.coolify.yaml run --rm --no-deps gateway caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker build --pull --target runtime -t defense-tech-monitor:local .
```

`config --quiet` avoids printing resolved secrets. Do not publish full resolved Compose output. Docker uses standalone Next.js output; normal `npm run build` and `npm start` retain the local loopback workflow.

Deploy the chosen revision in Coolify. Keep a single app instance, without parallel deployments or Swarm. Replacements can briefly interrupt access. Check the app and gateway logs, then verify:

```sh
curl --head http://defense.example.com
curl --head https://defense.example.com
curl --user your-login --head https://defense.example.com
```

HTTP should redirect to HTTPS. HTTPS without credentials should return `401`; authenticated access should open the application. The final command prompts for the password. In the browser, verify that existing sources, feeds, saved items, and settings are present. Check **Sources** for the collection schedule and **Profil de veille** for provider configuration before requesting paid work.

## Persistent data

The `app_data` volume stores `/app/data/monitor.sqlite` and SQLite's working files. A new volume receives UID/GID 1000 ownership from the nonroot `node` account in the image. Record the effective Docker volume name in Coolify's Persistent Storage or the generated deployment configuration; Coolify can prefix it.

Keep the same Coolify resource and volume during updates. An image replacement preserves the volume. Removing the resource's storage, using a different volume, or running `docker compose down -v` loses access to its data. Keep only one application server on this volume. Database migrations run on first open; an older application may require its matching backup instead of the migrated database.

## Create a consistent backup

Run these commands on the VPS. Find this resource's exact app container name in Coolify, then set it below. Do not select another application's `app` container. The backup command executes a short Node SQLite process inside the existing container; it does not start another application or worker.

```sh
DTM_CONTAINER=replace-with-this-app-container-name
DTM_BACKUP="monitor-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
docker exec -i -e DTM_BACKUP="$DTM_BACKUP" "$DTM_CONTAINER" node --input-type=module <<'NODE'
import { backup, DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';

const directory = '/app/data/backups';
mkdirSync(directory, { recursive: true, mode: 0o700 });
const target = `${directory}/${process.env.DTM_BACKUP}`;
if (existsSync(target)) throw new Error('Backup already exists');
const source = new DatabaseSync(process.env.DTM_DATABASE_PATH, {
  readOnly: true,
  timeout: 5000,
});
try {
  await backup(source, target);
} finally {
  source.close();
}
const snapshot = new DatabaseSync(target);
try {
  snapshot.exec('PRAGMA journal_mode = DELETE');
  const checks = snapshot.prepare('PRAGMA quick_check').all();
  if (checks.length !== 1 || checks[0].quick_check !== 'ok') {
    throw new Error('Backup integrity check failed');
  }
} finally {
  snapshot.close();
}
chmodSync(target, 0o600);
console.log(`Verified ${target}`);
NODE
```

Continue only after the command succeeds and prints `Verified`. SQLite's backup API includes committed WAL data while the app runs; copying only a live `monitor.sqlite` file can miss it. The resulting snapshot uses a single file. Download it outside the VPS:

```sh
mkdir -p "$HOME/defense-tech-monitor-backups"
chmod 700 "$HOME/defense-tech-monitor-backups"
docker cp "$DTM_CONTAINER:/app/data/backups/$DTM_BACKUP" "$HOME/defense-tech-monitor-backups/$DTM_BACKUP"
chmod 600 "$HOME/defense-tech-monitor-backups/$DTM_BACKUP"
```

Then, on your own computer, copy that file through your usual SSH connection, for example:

```sh
scp vps-user@vps-host:~/defense-tech-monitor-backups/monitor-YYYYMMDDTHHMMSSZ.sqlite ./
```

Keep an off-server backup before each update and note the deployed revision. Store secrets separately: SQLite backups include sources, personal state, provider results and spending ledgers, but do not include environment variables or API keys. Copies left only in the app volume or VPS home directory do not protect against losing the server.

## Restore or migrate local data

First create a current backup. Restoring replaces all application data, including schedules and spending ledgers. Set both paid budgets to `0` in Coolify for the first start after restoration; review retained modes and current-month provider spending before enabling them again. A restored older ledger cannot account for charges made after its snapshot.

For migration from the Mac, stop the local app and any collection command, then use Node 24's same `backup()` API with `data/monitor.sqlite` as the source and a new file outside the project as the destination. Apply `PRAGMA journal_mode = DELETE` and `PRAGMA quick_check` to that destination as above, and close both connections before transfer. Do not upload `.env.local` or copy an active database without its WAL. Transfer the verified snapshot to a private location on the VPS.

On the VPS, record the target app container, its image, and its volume before stopping it. Replace the example restore path with the absolute path to your verified snapshot:

```sh
DTM_CONTAINER=replace-with-this-app-container-name
DTM_RESTORE_FILE=/absolute/path/to/verified-monitor.sqlite
DTM_VOLUME="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' "$DTM_CONTAINER")"
DTM_IMAGE="$(docker inspect --format '{{.Image}}' "$DTM_CONTAINER")"
test -n "$DTM_VOLUME" && test -n "$DTM_IMAGE" && test -f "$DTM_RESTORE_FILE"
```

If any check fails, stop and correct the identifiers. Pause Coolify auto-deployments for maintenance. Stop the resource in Coolify and confirm that its app container is stopped. Do not let Coolify deploy or restart it during restoration. Ensure the snapshot is readable by UID 1000, for example with `sudo chown 1000:1000 "$DTM_RESTORE_FILE"` and `sudo chmod 600 "$DTM_RESTORE_FILE"`.

Run this offline helper only while the app is stopped. It overrides the image entrypoint, has no network, validates the snapshot before replacing data, and retains the previous database and sidecars in a `restore-*` directory:

```sh
docker run --rm -i --network none --user 1000:1000 \
  --mount "type=volume,src=$DTM_VOLUME,dst=/app/data" \
  --mount "type=bind,src=$DTM_RESTORE_FILE,dst=/backup.sqlite,readonly" \
  --entrypoint node "$DTM_IMAGE" --input-type=module <<'NODE'
import { backup, DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdtempSync, renameSync } from 'node:fs';

function check(database) {
  const checks = database.prepare('PRAGMA quick_check').all();
  if (checks.length !== 1 || checks[0].quick_check !== 'ok') {
    throw new Error('SQLite integrity check failed');
  }
}
const directory = mkdtempSync('/app/data/restore-');
const staged = `${directory}/replacement.sqlite`;
const source = new DatabaseSync('/backup.sqlite', { readOnly: true });
try {
  check(source);
  await backup(source, staged);
} finally {
  source.close();
}
const replacement = new DatabaseSync(staged);
try {
  replacement.exec('PRAGMA journal_mode = DELETE');
  check(replacement);
} finally {
  replacement.close();
}
chmodSync(staged, 0o600);
for (const suffix of ['', '-wal', '-shm']) {
  const previous = `/app/data/monitor.sqlite${suffix}`;
  if (existsSync(previous)) {
    renameSync(previous, `${directory}/monitor.sqlite${suffix}`);
  }
}
renameSync(staged, '/app/data/monitor.sqlite');
console.log(`Restored; previous files retained in ${directory}`);
NODE
```

Restart the single resource in Coolify with the intended application revision and the same volume. Check the startup logs and authenticated interface. Confirm personal data, schedules, and provider settings; then restore auto-deployment settings as appropriate. Local and VPS databases become independent after copying. Stop the local workers when moving regular use to the VPS to avoid running two separate collection and paid-processing schedules.

## References

- [Coolify Docker Compose applications](https://coolify.io/docs/applications/builds/docker-compose)
- [Coolify runtime variables and literal values](https://coolify.io/docs/applications/configuration/environment-variables)
- [Docker embedded configurations](https://docs.docker.com/reference/compose-file/configs/)
- [Caddy HTTP Basic authentication](https://caddyserver.com/docs/caddyfile/directives/basic_auth)
- [Caddy forwarding and request headers](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
- [Caddy request body limits](https://caddyserver.com/docs/caddyfile/directives/request_body)
- [Node 24 SQLite backup API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html#sqlitebackupsourceDb-path-options)
