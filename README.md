# Depot CI Snapshot Action

Snapshot Depot CI filesystem changes and push filesystem snapshots to the Depot registry.

## Usage

```yaml
jobs:
  snapshot:
    runs-on: depot-ubuntu-latest
    steps:
      - uses: depot/snapshot-action@v1
        with:
          image: |
            orgid.registry.depot.dev/repo:latest
            orgid.registry.depot.dev/repo:1.1
          max-age: 2d
```

When `image` contains multiple refs, they must point to the same registry repository. This is multi-tag publishing, not multi-registry replication.

### Preventing certain environment variables to be captured in the snapshot

Some well-known secrets, API tokens, and secret prefixes are excluded from the snapshot by default. For the detailed list, see the [documentation](https://depot.dev/docs/ci/how-to-guides/custom-images#snapshot-a-sandbox-to-build-a-custom-image).

```yaml
jobs:
  snapshot:
    runs-on: depot-ubuntu-latest
    steps:
      - uses: depot/snapshot-action@v1
        with:
          image: orgid.registry.depot.dev/repo:tag
          env-mask: |
            MY_ENV
            MY_SUPER_SECRET_TOKEN
            API_TOKEN
```

## Inputs

| Input      | Required | Default                 | Description                                                                                                       |
| ---------- | -------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `token`    | No       | `''`                    | Depot API token used as registry password.                                                                        |
| `image`    | **Yes**  | —                       | Full image reference, or newline-delimited refs in the same repository (e.g. `orgid.registry.depot.dev/repo:tag`) |
| `env-mask` | No       | `''`                    | Prevent certain environment variables from being persistend in the snapshot                                       |
| `max-age`  | No       | `''`                    | Optional snapshot tag TTL. Supports `s`, `m`, `h`, and `d` units, for example `2d` or `1h30m`.                    |
| `base`     | No       | `/dev/vdb`              | Base block device                                                                                                 |
| `upper`    | No       | `/rw/.snap/upper`       | Upper directory for overlay                                                                                       |
| `snapshot` | No       | `/rw/overlay:/rw/.snap` | Overlay:snap mapping                                                                                              |
| `version`  | No       | `latest`                | Snapshot binary version                                                                                           |

## License

MIT License - see [LICENSE](LICENSE) for details.
