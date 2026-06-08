# Policies

## English

Machine-readable example policies that mirror the playbook's conceptual
guardrails (Tier model, protected files, approval rules, quality gates).

> **These are reference examples. They do not enforce anything on their own.**
> A YAML file that looks executable is not a control. These policies only have
> effect once a harness, CI system, or repository protection mechanism reads
> them and acts on them. Adopting them does not, by itself, make a repository
> safe. Each file carries `status: example` to make this explicit.

| File | Purpose |
|---|---|
| [`task-risk-tiers.yaml`](./task-risk-tiers.yaml) | The Tier 1/2/3 model as data: allowed actions, required review, escalation triggers. |
| [`protected-files.yaml`](./protected-files.yaml) | Path globs where agents should stop or escalate (secrets, prod config, CI/CD, migrations). |
| [`approval-rules.yaml`](./approval-rules.yaml) | When rigorous review or explicit human approval is required, derived from risk. |
| [`quality-gates.yaml`](./quality-gates.yaml) | Typical gate sets per maturity phase, build-system-agnostic. |

Glob semantics differ between harnesses, so `protected-files.yaml` in
particular is an example shape, not a portable, ready-to-run configuration.

## Deutsch

Maschinenlesbare Beispiel-Policies, die die konzeptuellen Leitplanken des
Playbooks spiegeln (Tier-Modell, geschützte Dateien, Approval-Regeln, Quality
Gates).

> **Dies sind Referenz-Beispiele. Sie erzwingen für sich genommen nichts.**
> Eine YAML-Datei, die ausführbar aussieht, ist keine Kontrolle. Diese Policies
> haben erst Wirkung, wenn ein Harness, ein CI-System oder ein
> Repository-Schutzmechanismus sie liest und darauf reagiert. Sie zu
> übernehmen macht ein Repository nicht von allein sicher. Jede Datei trägt
> `status: example`, um das deutlich zu machen.

| Datei | Zweck |
|---|---|
| [`task-risk-tiers.yaml`](./task-risk-tiers.yaml) | Das Tier-1/2/3-Modell als Daten: erlaubte Aktionen, erforderliches Review, Eskalations-Trigger. |
| [`protected-files.yaml`](./protected-files.yaml) | Pfad-Globs, bei denen Agenten stoppen oder eskalieren sollten (Secrets, Prod-Config, CI/CD, Migrationen). |
| [`approval-rules.yaml`](./approval-rules.yaml) | Wann rigoroses Review oder explizite menschliche Freigabe nötig ist, abgeleitet aus dem Risiko. |
| [`quality-gates.yaml`](./quality-gates.yaml) | Typische Gate-Sets je Reifephase, build-system-agnostisch. |

Glob-Semantik unterscheidet sich zwischen Harnesses, daher ist besonders
`protected-files.yaml` eine Beispiel-Form, keine portable, sofort lauffähige
Konfiguration.
