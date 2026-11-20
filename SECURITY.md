# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repository. Don't open a public issue for anything that could let someone bypass payment, read other users' data or steal funds or secrets.

Include what is affected, how to reproduce it, and the impact you expect. We'll acknowledge the report and keep you updated while we fix it.

## Malware in contributions

Every pull request is scanned for malware techniques, and so is the whole repository on every push to `main` and nightly. If a scan flags your pull request, it doesn't mean we think you did it on purpose: infected machines spread malware without their owners knowing. See [docs/security/malware-defense.md](docs/security/malware-defense.md) for what the scan checks, how maintainers review flagged changes, and how to check and clean your machine.

## Supported versions

Only the latest `main` is supported. ZentrixPay is not yet deployed to Stellar mainnet.
