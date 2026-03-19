# Depot CI Snapshot Action

Snapshot Depot CI filesystem changes and push filesystem snapshots to the Depot registry.

## Usage

### With OIDC authentication (recommended)

```yaml
jobs:
  snapshot:
    runs-on: depot-ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: depot/snapshot-action@v1
        with:
          image: orgid.registry.depot.dev/repo:tag
```

### With explicit token

```yaml
jobs:
  snapshot:
    runs-on: depot-ubuntu-latest
    steps:
      - uses: depot/snapshot-action@v1
        with:
          image: orgid.registry.depot.dev/repo:tag
          token: ${{ secrets.DEPOT_TOKEN }}
```

## Authentication

Authentication can be provided in two ways:

1. **OIDC (recommended)** — Omit the `token` input and add `id-token: write` permission. The action exchanges a GitHub Actions OIDC token for a temporary Depot token. For open-source pull requests from forks, a separate OIDC flow is used.

2. **Explicit token** — Set the `token` input to a Depot API token (e.g. from `secrets.DEPOT_TOKEN`). The token is masked in logs.

## Inputs

| Input      | Required | Default                 | Description                                                                    |
| ---------- | -------- | ----------------------- | ------------------------------------------------------------------------------ |
| `token`    | No       | `''`                    | Depot API token used as registry password. If not set, attempts OIDC exchange. |
| `image`    | **Yes**  | —                       | Full image reference (e.g. `orgid.registry.depot.dev/repo:tag`)                |
| `base`     | No       | `/dev/vdb`              | Base block device                                                              |
| `upper`    | No       | `/rw/.snap/upper`       | Upper directory for overlay                                                    |
| `snapshot` | No       | `/rw/overlay:/rw/.snap` | Overlay:snap mapping                                                           |
| `version`  | No       | `latest`                | Snapshot binary version                                                        |

## License

MIT License - see [LICENSE](LICENSE) for details.
