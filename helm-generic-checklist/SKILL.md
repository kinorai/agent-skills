---
name: helm-generic-checklist
description: Pre-deploy quality checklist for Helm charts on any Kubernetes cluster. Use when writing, changing, reviewing or auditing a values file, Chart.yaml, a vendored chart, or manifests rendered from Helm; when bumping a chart or image version; or when a Helm release fails to roll out (CrashLoopBackOff, ImagePullBackOff, pending PVC, failed probes). A project-specific deployment checklist, if one exists, adds its own conventions on top of this one.
---

# Helm Quality Checklist

A universal pre-deploy checklist for Helm charts. These checks apply to any Kubernetes cluster regardless of provider, size, or architecture.

## How to run it

1. Read the final values the release will actually get: the chart's defaults merged with every override file, in order. `helm template` or `helm get values` shows them better than any single file does.
2. Go through each section below. Mark every item **pass**, **fix** (with the change), or **n/a** (with a one-line reason). An item skipped without a reason is the one that bites later.
3. Make the fixes, then render again (`helm template`, `helm lint`, `helm diff` if available) to confirm they landed.

Report the outcome as a list of the **fix** items, then the **n/a** items with their reasons. Leave out the passes unless the user asks for them.

**Done when:** every section has been checked against the merged values, every fix has been applied and re-rendered, and every n/a has a reason.

---

## Release / Naming

- [ ] **Release name chosen and follows naming convention** — Helm uses the release name in resource names. Keep it short, lowercase, and descriptive. Changing it later means recreating everything.
- [ ] **Namespace confirmed** — always set the namespace explicitly. Relying on the current kubeconfig context is how you accidentally deploy to production.
- [ ] **Namespace contents checked** — verify nothing conflicting is already installed in the target namespace (same port, same ingress host, same PVC name).

## Chart / Versioning

- [ ] **Correct chart selected** — verify you're using the right chart for the workload (official vs community, generic vs purpose-built).
- [ ] **Chart version pinned** — don't use a floating chart version. Pin to a specific version so upgrades are intentional.
- [ ] **Chart release notes / breaking changes reviewed** — read the changelog between your current version and the target version. Breaking changes in values structure are common.
- [ ] **App version compatible with chart version** — some charts are tightly coupled to a specific app version range. Check Chart.yaml's `appVersion` and the chart docs.
- [ ] **Chart.yaml version bumped if modified** — if you modified a vendored chart, bump its version so Helm detects the change.

## Image

**Check the current stable image tag against a live source before deploying.** Stale tags are the most common silent problem: a version gets pinned once and sits for months while security patches and bug fixes ship. Your memory of "the latest version" is stale by construction, so look it up on Docker Hub, the project's GitHub releases, or its docs.

- [ ] **Latest stable version verified against a live source** — Docker Hub, GitHub releases or the official docs, checked now.
- [ ] **Image tag pinned to exact version + digest** — e.g. `postgres:18.3-bookworm@sha256:abcd...`. The digest makes the tag truly immutable. Version-only tags (`postgres:18.3`) can be overwritten by the publisher.
- [ ] **Image repository confirmed** — correct registry, correct image name.
- [ ] **Not using `latest`** — ever. It's mutable, uncacheable with `IfNotPresent`, and makes rollbacks impossible.
- [ ] **Not using major-only tags** — `postgres:18` or `nginx:1` are floating tags that silently change under you on every pull.
- [ ] **`imagePullPolicy` reviewed** — `IfNotPresent` for immutable tags (version + digest). `Always` only if you're using a mutable tag (which you shouldn't in production).
- [ ] **Image exists and is accessible** — typos in image names, private registry without `imagePullSecrets`, wrong architecture (amd64 image on arm64 node) are all common failures.
- [ ] **`imagePullSecrets` set for private registries** — without this, the kubelet can't authenticate to pull the image.
- [ ] **Multi-arch support checked** — if deploying to ARM64 nodes (Raspberry Pi, Graviton), verify the image has an arm64 manifest. Most official images do; many community images don't.

## Replicas / Scaling

- [ ] **`replicaCount` set intentionally** — don't leave it at the chart default without thinking about it.
- [ ] **HA requirement checked** — does this service need to survive a node going down? If yes, 2+ replicas.
- [ ] **Autoscaling enabled/disabled intentionally** — if the chart supports HPA, decide whether to use it. If enabled:
- [ ] **`minReplicas` and `maxReplicas` reviewed** — min should handle baseline load, max should respect cluster capacity.
- [ ] **CPU/memory scaling targets reviewed** — default 80% CPU target may not suit all workloads. Memory-bound services may need memory-based scaling.

## Resources

Every container must declare resource requests. Without them, the scheduler is guessing and your cluster is one memory spike away from cascading evictions.

- [ ] **CPU requests defined** — tells the scheduler how much CPU to reserve. Start low (10-100m for most services) and adjust from observed usage.
- [ ] **Memory requests defined** — must reflect the actual working set. Too low and the pod gets evicted under pressure; too high and you waste capacity.
- [ ] **Memory limits defined** — the hard ceiling. Without a limit, a memory leak in one pod can OOM-kill unrelated pods on the same node. Set to 1.5-2x the request as a starting point.
- [ ] **CPU limits set intentionally** — for long-running services (web servers, APIs), omit CPU limits to avoid throttling-induced latency spikes. For background/batch workloads (CronJobs, workers, init containers), set CPU limits to prevent them from starving other pods on the node.
- [ ] **Requests do not exceed limits** — this is an invalid configuration that Kubernetes will reject.
- [ ] **Init containers have resources** — they compete for node resources during startup. An init container without limits can starve the node while it runs.
- [ ] **Sidecar containers have resources** — same reasoning. Every container in the pod needs resource declarations.
- [ ] **Resource values match expected workload** — don't copy-paste from another service. Check the app's actual memory/CPU profile.
- [ ] **Ephemeral storage limits considered** — if containers write to emptyDir or the container filesystem, `ephemeral-storage` limits prevent a single pod from filling the node's disk.

## Ports / Service

- [ ] **Container port correct** — matches what the application actually listens on.
- [ ] **Service enabled/disabled intentionally** — not every container needs a Service (batch jobs, workers).
- [ ] **Service type correct** — `ClusterIP` for internal (default and most common), `NodePort` for dev/testing, `LoadBalancer` for external exposure, `None` (headless) for StatefulSets needing stable DNS per pod.
- [ ] **Service port and targetPort correct** — if the container listens on 8080, targetPort is 8080. The service port can be anything (commonly 80).
- [ ] **Port names follow convention** — use protocol-based names (`http`, `https`, `grpc`, `tcp-<name>`) so service meshes can identify the protocol. Kubernetes rejects names over 15 characters (IANA): `prometheus-metrics` fails, `prom-metrics` works.

## Ingress / Exposure

- [ ] **Ingress enabled/disabled intentionally** — not every service needs external access.
- [ ] **Hostname(s) confirmed** — correct domain, no typos.
- [ ] **Path(s) confirmed** — correct prefix/exact match for the service.
- [ ] **Ingress class confirmed** — use the cluster default unless there's a reason to specify one.
- [ ] **TLS configured** — no plaintext HTTP exposed to the internet. Use cert-manager or pre-provisioned certs.
- [ ] **Ingress annotations for your controller** — different controllers (nginx, traefik, ALB) use different annotation prefixes. Make sure you're using the right ones.

## Health Checks

Probes are how Kubernetes knows whether your container is working. Without them, traffic goes to dead containers and hung processes never restart.

- [ ] **Readiness probe configured** — removes the pod from Service endpoints when it can't serve traffic. This is what gives you zero-downtime deploys. It CAN check downstream dependencies if the service genuinely can't serve without them.
- [ ] **Liveness probe configured** — restarts the container when it's deadlocked or hung. Do NOT point this at an endpoint that depends on external services (database, cache) — a downstream outage shouldn't restart your pod.
- [ ] **Startup probe configured if app starts slowly** — suppresses liveness checks during startup so the container doesn't get killed while it's still coming up. Set `failureThreshold * periodSeconds >= maximum startup time`.
- [ ] **Probe path/port correct** — pointing to the right endpoint on the right port.
- [ ] **Probe endpoints are cheap** — don't use a health endpoint that queries the database or does anything expensive. A dedicated `/healthz` that returns 200 is ideal.
- [ ] **Probe timings realistic** — `timeoutSeconds` < `periodSeconds`. Typically: `periodSeconds: 10`, `timeoutSeconds: 3`. Prefer startup probes over large `initialDelaySeconds`.
- [ ] **Failure thresholds match criticality** — `failureThreshold: 3` is a good default. Lower (1-2) for critical fast-restart services. Higher (5+) for services with known intermittent health check failures.

## Security

Security must be hardened by default, not bolted on after deployment. Every deployment should follow least-privilege principles at every layer.

### Pod Level
- [ ] **`runAsNonRoot: true`** — prevents the container from running as root, even if the image's Dockerfile says `USER root`.
- [ ] **`runAsUser` / `runAsGroup` set explicitly** — don't rely on the image default. Pin to the application's expected UID/GID (e.g. 999 for postgres, 65534 for nobody).
- [ ] **`fsGroup` set** — ensures mounted volumes are accessible to the container's group. Without this, PVC mounts may be unreadable.
- [ ] **`seccompProfile: RuntimeDefault`** — applies the container runtime's default syscall filter. No reason to skip this unless the app needs specific syscalls (very rare).

### Container Level
- [ ] **`readOnlyRootFilesystem: true`** — prevents writes to the container filesystem. Forces you to explicitly declare writable paths via emptyDir or PVC mounts.
- [ ] **`allowPrivilegeEscalation: false`** — prevents processes from gaining more privileges than their parent.
- [ ] **`capabilities.drop: [ALL]`** — drops all Linux capabilities. Add back only what's needed (e.g., `NET_BIND_SERVICE` for ports < 1024).
- [ ] **EmptyDir mounts for /tmp, /run, /var/cache** — if using read-only root filesystem, the app still needs to write temp files somewhere. Always set `sizeLimit` on emptyDir.
- [ ] **No `privileged: true`** — gives the container full access to the host. Almost never needed. If you think you need it, you probably need a specific capability instead.
- [ ] **`automountServiceAccountToken: false`** — unless the pod needs Kubernetes API access. Most application pods don't.

### Application-Level Authentication (databases and other stateful services)
- [ ] **No `trust` in pg_hba.conf or equivalent** — never allow unauthenticated connections, not even local socket. Use `scram-sha-256` (postgres), TLS client certs, or equivalent for every service.
- [ ] **Strongest auth method used** — `scram-sha-256` over `md5` for PostgreSQL, bcrypt over plaintext for application passwords. Check what the application supports and use the strongest option.
- [ ] **Default databases/schemas hardened** — PostgreSQL grants CREATE on the `public` schema to everyone by default. In initdb, `REVOKE CONNECT FROM PUBLIC` on template and default databases and `REVOKE ALL ON SCHEMA public FROM PUBLIC`.
- [ ] **Admin/debug endpoints disabled** — no phpMyAdmin, pgAdmin, Redis Commander exposed. No debug ports, profiling endpoints, or status pages accessible without auth.
- [ ] **Password encryption enforced** — set `password_encryption = 'scram-sha-256'` or equivalent explicitly in config, not just in pg_hba.

### Network Security
- [ ] **Databases/caches not exposed via Ingress** — internal services should only be reachable within the cluster. No external LoadBalancer for databases.
- [ ] **Replication restricted to pod CIDR** — if using streaming replication, pg_hba / ACLs should only allow from the pod network (e.g. `10.42.0.0/16`), not `0.0.0.0/0`.

## Service Account / RBAC

- [ ] **Service account creation reviewed** — does this service need its own SA? Most don't.
- [ ] **Dedicated service account used if needed** — for services that interact with the Kubernetes API (operators, controllers, CI/CD).
- [ ] **RBAC enabled only if required** — don't create Roles/ClusterRoles unless the service actually needs API access.
- [ ] **Permissions reviewed for least privilege** — if RBAC is needed, scope it to the minimum: specific resources, specific verbs, namespace-scoped over cluster-scoped.

## Configuration / Environment Variables

- [ ] **Required env vars provided** — check the app's documentation for mandatory configuration.
- [ ] **Environment-specific config checked** — dev/staging/prod differences accounted for.
- [ ] **Log level set correctly** — `info` for production, `debug` only when actively troubleshooting.
- [ ] **Debug mode disabled in production** — debug endpoints, verbose logging, profiling should be off.
- [ ] **External endpoints/URLs confirmed** — database URLs, API endpoints, cache addresses all pointing to the right targets.

## Secrets

- [ ] **No secrets in plain text in values files** — Helm values end up in Helm release secrets stored in the cluster. Use external secret management (external-secrets, sealed-secrets, Vault) or the Terraform Helm provider's `set_sensitive`.
- [ ] **No secrets in ConfigMaps** — passwords in initdb scripts end up in ConfigMaps. Use Secret references + env vars instead.
- [ ] **Existing Secret references confirmed** — if referencing a pre-existing Secret, verify it exists in the target namespace with the expected keys.
- [ ] **Secret keys/names checked** — typos in Secret names or key names fail silently (empty string) or loudly (pod won't start) depending on `optional` flag.
- [ ] **DB/API credentials provided securely** — through Secret references, not env var literals in values.

## Persistence / Storage

- [ ] **Persistence enabled/disabled intentionally** — don't leave it at chart default without deciding.
- [ ] **Storage class set explicitly** — relying on the cluster default works until someone changes it. Be explicit.
- [ ] **PVC size confirmed** — size for 2x current usage or set up monitoring. Disks at 100% cause hard-to-debug failures.
- [ ] **Access mode correct** — `ReadWriteOnce` for single-pod (most cases). `ReadWriteMany` only when multiple pods need concurrent writes (requires storage provider support).
- [ ] **Existing claim checked if reused** — if referencing an existing PVC, verify it exists and isn't bound to another pod.
- [ ] **Reclaim policy matches importance** — `Retain` for anything you care about. `Delete` only for truly ephemeral data.
- [ ] **Backup/retention expectations known** — how is this data backed up? What's the RPO?
- [ ] **Workload type matches persistence** — StatefulSet if stable pod identity is needed or if multiple replicas each need their own PVC. Deployment with `Recreate` strategy is fine for single-replica + shared PVC.

## Scheduling

- [ ] **`nodeSelector` reviewed** — pin to specific nodes only when there's a real reason (hardware requirement, data locality).
- [ ] **`tolerations` reviewed** — if the target node has taints, the pod needs matching tolerations.
- [ ] **`affinity` / `antiAffinity` reviewed** — co-locate with dependencies (affinity) or spread for HA (anti-affinity).
- [ ] **Topology spread considered for HA** — `topologySpreadConstraints` ensures pods distribute across failure domains.
- [ ] **Pod placement constraints validated** — run through the scenario: if node X goes down, where does this pod land?

## Availability / Rollout

- [ ] **Update strategy explicit** — `Recreate` for single-replica + PVC (prevents deadlock). `RollingUpdate` for stateless multi-replica.
- [ ] **`maxUnavailable` / `maxSurge` reviewed** — `maxSurge: 1, maxUnavailable: 0` for zero-downtime. `maxSurge: 0, maxUnavailable: 1` if capacity-constrained.
- [ ] **PodDisruptionBudget enabled if needed** — prevents voluntary disruptions (node drain, cluster upgrade) from killing too many pods at once. Set `minAvailable` or `maxUnavailable`.
- [ ] **`terminationGracePeriodSeconds` reviewed** — default is 30s. Increase for services that need time to drain connections or finish in-flight work.
- [ ] **`preStop` hook reviewed if needed** — for graceful shutdown (e.g., deregister from service discovery, finish processing queue items).
- [ ] **`revisionHistoryLimit` set** — defaults to 10. Lower to 3-5 on clusters with many Deployments to reduce etcd pressure.

## Network / Connectivity

- [ ] **NetworkPolicy enabled/disabled intentionally** — if the cluster enforces them, define ingress/egress rules.
- [ ] **Required ingress traffic allowed** — from ingress controller, from dependent services.
- [ ] **Required egress traffic allowed** — to databases, external APIs, DNS.
- [ ] **Unnecessary ports/access not exposed** — principle of least privilege applies to network access too.

## Observability

- [ ] **Metrics enabled if available** — most production charts expose Prometheus metrics. Enable them.
- [ ] **Metrics exporter has resource limits** — exporter sidecars need their own requests/limits (e.g. 10m/32Mi request, 64Mi limit). Don't leave them unlimited.
- [ ] **ServiceMonitor/PodMonitor enabled if needed** — for Prometheus-based monitoring stacks.
- [ ] **Logs accessible** — verify the service logs to stdout/stderr (not just to files inside the container).
- [ ] **Monitoring/alerting expectations known** — what should trigger an alert? CPU > 90%? Error rate > 1%?
- [ ] **Tracing config reviewed if used** — OpenTelemetry endpoints, sampling rate, propagation format.

## Dependencies / Subcharts

- [ ] **Internal DB/Redis/etc. enabled/disabled intentionally** — many charts bundle subcharts for databases. Decide: use the bundled one or point to an external instance.
- [ ] **External dependency endpoints confirmed** — if using external services, verify the connection strings.
- [ ] **Test/demo/example components disabled** — some charts ship with test pods, example data, or demo modes. Disable them.

## Helm Execution

- [ ] **Values file reviewed line by line** — before running install/upgrade, read through the final values. No surprises.
- [ ] **Environment override file correct** — if using multiple values files, verify the right one is selected.
- [ ] **`helm template` renders cleanly** — catches YAML syntax errors, missing required values, and template logic bugs without touching the cluster.
- [ ] **`helm lint` run** — catches common chart issues.
- [ ] **`helm diff` reviewed** — if using the helm-diff plugin, review the diff before applying. Catches unexpected changes from value inheritance or upstream chart updates.
- [ ] **Values merge order is intentional** — Helm merges values files left to right (last wins). Understand which file takes precedence.

## Post-Install Validation

- [ ] **Pods created successfully** — correct number of pods in the expected namespace.
- [ ] **Pods become Ready** — all containers in the pod pass readiness checks.
- [ ] **No CrashLoopBackOff / ImagePullBackOff** — check `kubectl get pods` and `kubectl describe pod` for error states.
- [ ] **Service endpoints created** — `kubectl get endpoints` shows the expected pod IPs.
- [ ] **Ingress works** — if configured, the hostname resolves and returns the expected response.
- [ ] **TLS works** — certificate is valid, no mixed content warnings.
- [ ] **App responds correctly** — not just "200 OK" but the actual expected behavior.
- [ ] **Logs checked** — no errors or warnings during startup.
- [ ] **Metrics checked** — if metrics are enabled, verify they're being scraped.
- [ ] **PVC bound if used** — `kubectl get pvc` shows `Bound` status.
- [ ] **Rollout status successful** — `kubectl rollout status` confirms completion.

## Common Pitfalls

- **Env var ordering** — in some charts, environment variables can reference each other. If `VAR_B` depends on `VAR_A`, `VAR_A` must be defined first. Not all chart templates preserve order.
- **Empty string vs null** — in Helm values, `key: ""` and `key:` (null) are different. Some charts treat them differently. If removing a value, check whether the chart expects null or empty string.
- **YAML gotchas** — `yes`/`no`/`on`/`off` are booleans in YAML 1.1. Quote them if you mean strings. Port `22` and version `1.20` are numbers — quote them if the chart expects strings.
- **Large ConfigMaps** — Kubernetes has a 1MB limit on individual objects. If your values generate a ConfigMap with a large embedded config file, you'll hit this silently during `helm upgrade`.
