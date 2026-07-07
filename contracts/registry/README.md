# Playground Registry

On-chain registry of .dot apps for the Polkadot app store. Each app is identified by its `.dot` domain and maps to an IPFS metadata URI containing its store page information (description, icon, screenshots, etc.).

Ownership is claimed on first publish. The owner, sudo/admin, or original
publisher can update a listing's metadata and visibility; ownership is
preserved on re-publish.

## Storage

| Key | Value | Description |
|-----|-------|-------------|
| `app_count` | `u32` | Total number of registered apps |
| `domain_at[index]` | `String` | Maps sequential index to .dot domain (for paginated listing) |
| `metadata_uri[domain]` | `String` | IPFS CID pointing to app metadata on Bulletin |
| `info[domain]` | `AppInfo { owner, visibility, publisher }` | Ownership record for each domain |

## Methods

### `publish(domain, metadata_uri, visibility, owner, modded_from, is_moddable, is_dev_signer)`
Guarded/scored publish path. `owner` must be `None`, so the caller becomes the
owner on first publish. Fresh publishes can award deploy XP regardless of
public/private visibility, and fresh mods can award source-app mod XP/count.
`is_dev_signer` is retained for ABI compatibility and ignored.

### `publish_dev(domain, metadata_uri, visibility, owner, modded_from, is_moddable)`
Ungated dev-signer path. Only the known CLI dev signer can call it. It may set
`owner`, records metadata and lineage, and never awards deploy XP or source-app
mod XP/count.

### `get_metadata_uri(domain) -> Option<String>`
Returns the IPFS metadata CID for a given .dot domain, or `None` if not registered.

### `get_app_data(domains, voter) -> Vec<AppData>`
Batch read for app rows. For each domain returns metadata URI, owner,
visibility, publisher, star count, mod count, and whether `voter` has starred
that app.

### `get_domain_at(index) -> String`
Returns the .dot domain at the given index. Used for paginated enumeration (infinite scroll). Returns empty string if index is out of bounds.

### `get_app_count() -> u32`
Returns the total number of registered apps.

### `get_owner(domain) -> Address`
Returns the owner of a .dot domain listing, or zero address if not registered.
