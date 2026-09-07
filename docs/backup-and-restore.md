# Back up and restore Noodle Core

**Owns:** The manual PostgreSQL, asset-volume, and encryption-key backup/restore procedure for the local
single-machine Noodle Core beta.
**Read when:** Protecting or recovering a self-hosted Noodle Core installation.
**Do not put here:** Managed Noodle Seed Cloud operations, high-availability design, or upgrade guarantees.
**Update when:** The local persistence layout, encryption boundary, or tested backup commands change.

Noodle Core has two durable stores that must be captured together: PostgreSQL and the `asset-data` volume.
The encryption key in `.self-host/.env` is a third, separately protected requirement. A named Docker volume
survives restarts, but it is not a backup.

This is a manual beta procedure for a quiescent single-machine stack. It is not point-in-time recovery and it
does not make database formats compatible across releases. Back up and restore with the same Noodle Core
revision unless a later compatibility guide explicitly says otherwise.

## Create a backup

Choose a protected existing parent directory outside the checkout and set its absolute path in
`NOODLE_BACKUP_PARENT`. The command creates a new timestamped child, stops Noodle so PostgreSQL and packaged
assets cannot change, and writes the two data artifacts there:

```sh
(
set -eu
umask 077
backup_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
checkout_root="$(pwd -P)"
backup_parent="${NOODLE_BACKUP_PARENT:?set NOODLE_BACKUP_PARENT to an absolute directory outside the checkout}"
case "$backup_parent" in
  /*) ;;
  *) echo "NOODLE_BACKUP_PARENT must be absolute" >&2; exit 1 ;;
esac
backup_parent="$(cd "$backup_parent" && pwd -P)"
case "$backup_parent" in
  "$checkout_root"|"$checkout_root"/*) echo "backup parent must be outside the checkout" >&2; exit 1 ;;
esac
backup_dir="$backup_parent/noodle-backup-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$backup_dir"
chmod 700 "$backup_dir"

docker compose stop noodle
restart_noodle() { docker compose up --wait noodle >/dev/null 2>&1 || true; }
trap restart_noodle EXIT HUP INT TERM
docker compose exec -T postgres pg_dump \
  -U noodle -d noodle --format=custom \
  > "$backup_dir/database.dump"
docker compose exec -T postgres pg_restore --list \
  < "$backup_dir/database.dump"

docker compose --profile tools run --rm --no-deps -T \
  --entrypoint tar noodle -C /var/lib/noodle/assets -czf - . \
  > "$backup_dir/assets.tar.gz"

tar -czf "$backup_dir.tar.gz" -C "$backup_dir" database.dump assets.tar.gz
chmod 600 "$backup_dir/database.dump" "$backup_dir/assets.tar.gz" "$backup_dir.tar.gz"
test "$(backup_mode "$backup_dir")" = 700
test "$(backup_mode "$backup_dir/database.dump")" = 600
test "$(backup_mode "$backup_dir/assets.tar.gz")" = 600
test "$(backup_mode "$backup_dir.tar.gz")" = 600
tar -tzf "$backup_dir.tar.gz"
tar -tzf "$backup_dir/assets.tar.gz"
docker compose up --wait noodle
trap - EXIT HUP INT TERM
)
```

The short-lived asset maintenance container uses the local source-built Noodle image and the existing asset
volume; it does not start the service or publish a port. The normal PostgreSQL and Noodle containers remain
non-root and hardened as described in the [self-hosting guide](self-hosting.md).

The final two archive-listing commands check both archives before the stack restarts. Review their output before
moving the backup to protected storage.

The combined archive must contain only `database.dump` and `assets.tar.gz`. Do not add `.self-host/.env` to
it. Back up `.self-host/.env` separately in an encrypted secrets manager or equivalent protected store, and
retain its `0600` permissions when restoring it. Losing `NOODLE_SECRET_MASTER_KEY` can make encrypted stored
values unrecoverable even when the database dump is intact. The adjacent `.env.postgres`, `.env.noodle`, and
`.env.operator` files are derived from the canonical file; do not back them up separately.

## Restore a backup

Restore only into a fresh checkout at the same revision with empty Noodle Core volumes. Do not overwrite a
running installation or mix this procedure with `--replace-secrets`.

1. Run `noodle service init --profile open-core --compose` in the fresh checkout.
2. Retrieve the separately protected original `.self-host/.env`, place it at that exact path, and set mode
   `0600`.
3. Run `noodle service init --profile open-core --compose` again. This preserves the restored canonical file
   and regenerates the three service-specific environment files from it.
4. Extract the combined archive into a protected directory outside the checkout and set its absolute path in
   `NOODLE_RESTORE_DIR`. That directory must contain `database.dump` and `assets.tar.gz`.
5. From the checkout root, restore PostgreSQL and assets, then start the service:

```sh
(
set -eu
checkout_root="$(pwd -P)"
restore_dir="${NOODLE_RESTORE_DIR:?set NOODLE_RESTORE_DIR to an absolute directory outside the checkout}"
case "$restore_dir" in
  /*) ;;
  *) echo "NOODLE_RESTORE_DIR must be absolute" >&2; exit 1 ;;
esac
restore_dir="$(cd "$restore_dir" && pwd -P)"
case "$restore_dir" in
  "$checkout_root"|"$checkout_root"/*) echo "restore directory must be outside the checkout" >&2; exit 1 ;;
esac
docker compose up --wait postgres
docker compose exec -T postgres pg_restore \
  --clean --if-exists --exit-on-error --no-owner --no-privileges \
  -U noodle -d noodle \
  < "$restore_dir/database.dump"

docker compose build noodle
docker compose --profile tools run --rm --no-deps -T \
  --entrypoint tar noodle -C /var/lib/noodle/assets -xzf - \
  < "$restore_dir/assets.tar.gz"

docker compose up --wait noodle
docker compose run --build --rm bootstrap
)
```

Verify `http://127.0.0.1:8787/readyz`, then call at least one previously deployed MCP endpoint and fetch one
previously hosted widget asset. Keep the backup until those checks pass. Deployment rollback changes the
active app deployment; it does not restore or downgrade the runtime database.
