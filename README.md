# Terrarium

Terrarium is a browser-local systems playground for Linux machines, networking,
storage and runtime experiments.

Open the application at https://niklas-olsson.github.io/.

This repository contains the current published static distribution. Each
publication replaces its Git snapshot with one parentless commit. It does not
contain the development workspace or development history.

Browser capabilities, device resources and the selected runtime determine which
features can run. Distribution of an asset does not establish qualification for
every browser, device or workload.

## Deploy your own copy

Follow [self-deployment](docs/self-hosting.md) to acquire and retain a verified
copy, serve it at your own origin and check a persistent guest result. The guide
separates the hosting recipe, observed qualification and unsupported cases.

## Licenses and source

Terrarium's application license is [Apache-2.0](LICENSE). Third-party software
retains its own licenses and notices in [runtime notices](runtime/THIRD_PARTY_NOTICES.md).
See [runtime source distribution](docs/runtime-sources.md) for the corresponding
source archives, their exact identities and reconstruction limitations.

The runtime source release tags are distribution pointers. The named source
archive bytes and digests identify the corresponding source kits independently
of the current Git snapshot.
