# Post-MVP Work

## Release-based image publishing

The initial GitHub Actions workflow publishes the Docker image on pushes to
`main`. Later, add release-based publishing so production image tags are
created from GitHub releases or version tags, with a stable tag policy and a
clear update procedure for the Scriberr Compose deployment.

## Operational enhancements

- Adaptive polling intervals and more advanced backoff policy.
- A Scriberr list-endpoint reconciliation pass in addition to filesystem discovery and persisted jobs.
- A health endpoint for Docker and Uptime Kuma.
- Application metrics such as jobs by state, API failures, MQTT failures, and processing durations.
- Configurable permissive job-ID matching for deployments with nonstandard Scriberr directory names.
- Multi-architecture image publishing if the image is used beyond the current Docker host.
