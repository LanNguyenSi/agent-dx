# Enterprise Agentic Coding Playbook
**Executive Version**

*Lan Nguyen Si | März 2026*
*Basiert auf dem [Agent Engineering Playbook](https://github.com/LanNguyenSi/agent-engineering-playbook)*

---

## Über den Autor

**Lan Nguyen Si** ist Softwareentwickler mit Fokus auf GovTech und Open Source. Er entwickelt Werkzeuge an der Schnittstelle zwischen KI-gestützter Softwareentwicklung und strukturierter Governance, darunter [project-forge](https://github.com/LanNguyenSi/project-forge), [depsight](https://github.com/LanNguyenSi/depsight) und das [Agent Engineering Playbook](https://github.com/LanNguyenSi/agent-engineering-playbook).

Dieses Playbook ist aus der Praxis entstanden: mit echten Projekten, echten Agents und echten Fehlern. Auch dieses Dokument selbst wurde im Dialog zwischen Mensch und KI erarbeitet.

---

## Die Kernthese

Der Wettbewerb in der Softwareentwicklung verschiebt sich. Nicht mehr: wer hat die besten Entwickler? Sondern: wer hat das beste System aus Agent, Mensch und strukturierten Leitplanken?

Das Problem lösen nicht bessere Agents. Sondern besser designte Entscheidungssysteme.

```
Agents dürfen optimieren.
Menschen müssen verantworten.
Systeme müssen erzwingen.
```

Diese Dreiteilung ist keine Meinung, sondern eine strukturelle Notwendigkeit:

- Agents machen Fehler aus Kontextlücken, nicht aus Nachlässigkeit.
- Menschen machen Fehler aus Zeitdruck, nicht aus böser Absicht.
- Systeme machen keine Fehler durch Vergessen, wenn sie richtig konfiguriert sind.

Disziplin skaliert nicht. Systeme schon.

---

## Wo steht euer Unternehmen?

Ehrliche Bestandsaufnahme vor allen weiteren Schritten:

| Situation | Phase |
|-----------|-------|
| Kein CI/CD, kein Branch-Schutz, keine Gates | Phase 0: Exploration |
| CI/CD vorhanden, erste Gates einrichten | Phase 1: Product Build |
| Live-System mit echten Nutzern | Phase 2: Production |
| Compliance, Audit, Enterprise-Anforderungen | Phase 3: Enterprise |

Das Modell passt sich der Phase an. Phase 0 braucht keine vollständige Governance. Phase 3 braucht sie zwingend.

---

## Das Modell: Drei Rollen, klare Grenzen

| Rolle | Verantwortung | An KI delegierbar? |
|-------|---------------|-------------------|
| Product Owner | Ziele, Prioritäten, Anforderungen | Nein |
| Tech Lead / Architekt | Designentscheidungen, Risikobewertung | Vorschläge ja, Entscheidung nein |
| Entwickler | Implementierung, Tests, Review-Freigabe | Umsetzung ja, Freigabe nein |
| KI-Agent | Generieren, analysieren, verdichten | Innerhalb definierter Grenzen |
| Release Manager | Deployment-Freigabe, Rollback | Nein |

Jede kritische Funktion braucht einen menschlichen Verantwortlichen und eine Vertretung. Prozesse die von einer Person oder einem Agent allein abhängen, sind fragil.

In kleineren Teams können mehrere Rollen in einer Person zusammenfallen. Die Verantwortlichkeiten dürfen dabei trotzdem nicht unsichtbar werden.

---

## Das Tier-Modell: Was Agents dürfen

### Tier 1: Autonom
Agent handelt selbstständig, ohne vorgelagertes Review, solange keine produktive Wirkung entsteht:
- Code und Dokumentation lesen, analysieren, zusammenfassen
- Entwürfe generieren: Code, Tests, Dokumentation, Refactoring
- Lokale Tests und Linter ausführen
- Architekturoptionen vorschlagen
- Tickets und Beschreibungen ausformulieren

### Tier 2: Assistiert
Agent handelt, Mensch prüft vor Wirksamkeit:
- Commits und Pull Requests erstellen
- CI/CD-Konfiguration anpassen
- Datenbankschemas und Migrationen vorbereiten
- Sicherheitsrelevanten Code bearbeiten (Auth, Crypto, Zugriffssteuerung)
- Features in Legacy-Code integrieren

### Tier 3: Verboten
Auch mit nachgelagertem Review nicht zulässig:
- Eigene Pull Requests genehmigen
- In Produktion deployen ohne explizite menschliche Freigabe
- Produktionsdaten oder Backups löschen
- Sicherheitskontrollen oder Monitoring deaktivieren
- Zugangsberechtigungen eigenständig anlegen oder ändern
- Required Review Gates umgehen

---

## Wann KI: darf, muss, niemals

### Hoher Automatisierungshebel
Folgende Aufgaben eignen sich primär für KI-Unterstützung:

- Boilerplate und Wiederholungsstrukturen
- Unit-Tests für klar spezifizierte Funktionen
- Dokumentation aus vorhandenem Code ableiten
- Ersten Durchlauf eines Code-Reviews erstellen
- Dependency-Updates analysieren und Upgrade-PRs vorbereiten

### KI darf (mit Review)

| Aufgabe | Was der Mensch prüft |
|---------|---------------------|
| Architekturoptionen vorschlagen | Entscheidung trifft Mensch |
| Komplexe Bugs analysieren | Root Cause validieren |
| Refactoring in abgegrenzten Bereichen | Keine unbeabsichtigten Seiteneffekte |
| Kommunikation formulieren | Mensch sendet, nicht Agent |

### KI niemals (ohne explizite menschliche Freigabe im System verankert)

| Was | Präzisierung |
|-----|-------------|
| Produktionsdaten lesen oder schreiben | Lokale Dev-Daten: Tier 1. Staging: Tier 2. Produktion: Tier 3. |
| Credentials rotieren oder erzeugen | In allen Umgebungen Tier 3 |
| Secrets aus .env oder Secret Stores auslesen | Nur über definierte Injection-Mechanismen, nie direkt |
| Externe API-Calls mit Schreibzugriff | Tier 2 mit Approval-Gate, Tier 3 in Produktion ohne Freigabe |
| Kundenanfragen eigenständig beantworten | Rechtliche Verantwortung liegt beim Menschen |
| Angebote oder Verträge freigeben | Geschäftliche Verantwortung liegt beim Menschen |

---

## Greenfield vs. Brownfield

### Greenfield
Die Gates von Anfang an einrichten, nicht später:

```
Von Tag 1 erzwungen:
  Kein Merge ohne grünen CI-Lauf
  Kein Direct Push auf main
  Mindestens 1 menschliches Review pro PR
  Kein Deployment ohne Freigabe
```

### Brownfield: das Ratchet-Prinzip
Bestehende Codebases lassen sich nicht durch neue Standards überschreiben. Der Weg:

```
1. Baseline erfassen
   KI analysiert: Fehleranzahl, Coverage, CI-Fail-Rate, offene CVEs
   Mensch bewertet und priorisiert

2. Schranken auf Baseline setzen
   Aktuell 120 TypeScript-Fehler: Gate erlaubt maximal 120
   Niemals erhöhen, aber schrittweise reduzieren

3. Schrittweise verbessern
   Pro Sprint eine Kategorie verbessern
   KI schlägt Fixes vor, Mensch reviewt

4. Neuen Stand einfrieren
   120 -> 80 -> 40 -> 0
   System erzwingt den jeweils aktuellen Schwellenwert
```

Besondere Sorgfalt bei Brownfield: Migrationen, Auth-Logik und API-Breaking-Changes immer als Tier 2 oder 3 behandeln, unabhängig vom Reifegrad der Codebasis.

---

## Was das System erzwingen muss

### Mindest-Setup für jedes Projekt

```yaml
Branch Protection (main, release/*):
  Required CI checks: build, test, lint, typecheck
  Required reviews: mindestens 1 Mensch
  No force push, no direct push

Deployment:
  Nur nach grünem CI-Lauf
  Nur nach menschlicher Freigabe
  Audit-Log für jedes Deployment
```

### Stufenmodell

| Stufe | Ab wann | Was erzwungen wird |
|-------|---------|-------------------|
| Basis | Tag 1 | Build grün, 1 Review, kein Direct Push |
| Standard | 4 Wochen | + Tests grün, Lint fehlerfrei |
| Reif | 3 Monate | + Coverage-Minimum, Security-Scan |
| Enterprise | Kundenprojekte | + Performance-Budget, Compliance-Gate |

---

## Audit Trail

Jede Agent-Aktion die das System verändert muss nachvollziehbar sein:

| Ereignis | Pflichtfelder |
|----------|--------------|
| Code-Generierung | Agent-Identität, Aufgabe, geänderte Dateien, Reviewer |
| PR-Erstellung | Agent-Identität, menschlicher Reviewer, Merge-Zeitpunkt |
| Deployment | Auslöser, Agent-Beteiligung, Umgebung, Rollback-Plan |

Praktisch: Agent-Commits erhalten einen `Co-Authored-By`-Trailer. PR-Beschreibungen geben KI-Beteiligung an. Deploy-Logs erfassen ob die Änderung agent-gestützt war.

---

## Drei Fragen vor jeder Agent-Aufgabe

1. **Ist das Ergebnis reversibel**, wenn es falsch ist?
2. **Trägt ein Mensch die Verantwortung** für das Ergebnis?
3. **Gibt es ein System**, das verhindert, dass das Ergebnis ungeprüft in Produktion geht?

Alle drei Ja: Agent kann loslegen.
Eine Frage Nein: erst das System oder die Verantwortung klären.

---

## Der Einstieg

**Woche 1:** Phase-Assessment. Wo steht die Organisation ehrlich?

**Woche 2:** Branch Protection einschalten. Ratchet auf aktuellen Stand setzen.

**Monat 1:** Tier-Modell schriftlich fixieren. Ersten Automatisierungshebel aktivieren.

**Monat 3:** Erstes vollständiges Projekt mit Agent + Mensch + System. Metriken messen.

**Monat 6:** Retrospektive. Was hat das System durchgelassen, was es nicht hätte sollen?

---

## Aus der Praxis: Was uns diese Thesen gelehrt hat

Diese Beispiele stammen aus realer Arbeit mit KI-Agents. Kein Gedankenexperiment.

---

### Beispiel 1: Disziplin skaliert nicht

**Situation:** Zwei Agents entwickeln parallel an einem Produkt. Kein gemeinsames Regelwerk.

**Was passierte:** Ein Agent baute eine neue Seite mit eigenem Layout statt der etablierten `PageShell`-Komponente, hardcodierten Strings statt Lokalisierung, und registrierte den Nav-Link in der falschen Komponente (`Navbar.tsx` statt `AppShell.tsx`). Drei separate Fixes waren nötig, drei separate Deployments.

**Was ein System verhindert hätte:** Ein automatisierter Check auf fehlende i18n-Keys, ein PR-Template das explizit nach `PageShell`-Nutzung fragt, und eine Checkliste die vor dem Merge abgehakt wird.

**Lerneffekt:** CONTRIBUTING.md wurde reaktiv erstellt, nicht proaktiv. Das Playbook-Prinzip: Ways of Working gehören zu den ersten Commits eines Projekts, nicht zu den Fixes danach.

---

### Beispiel 2: Human-in-the-Middle in der Praxis

**Situation:** Ein Agent soll eine Jira-Aktion ausführen, die als "medium risk" klassifiziert ist.

**Was gebaut wurde:** Der Connector Proxy gibt bei riskanten Aktionen HTTP 202 zurück statt sie sofort auszuführen. Ein `ApprovalRequest`-Eintrag wird angelegt. Der Agent wartet. Der Mensch entscheidet per Freigabe-Seite im Dashboard. Erst dann führt der Agent die Aktion aus, mit vollständigem Audit Trail.

**Was das zeigt:** Human-in-the-Middle ist kein Hemmnis für Geschwindigkeit. Es ist ein strukturierter Übergabepunkt. Der Agent arbeitet weiter, der Mensch entscheidet wenn es zählt.

**Lerneffekt:** Der erste Entwurf der Freigabe sah vor, dass der Benutzer per `curl` genehmigt. Das ist kein Workflow für Menschen. Die richtige Frage ist immer: wie macht das der Benutzer ohne Terminal?

---

### Beispiel 3: Ways of Working brauchen System-Backing

**Situation:** Nach mehreren inkonsistenten PRs wird CONTRIBUTING.md erstellt mit klaren Regeln: PageShell immer, t() immer, AppShell für Nav, Primitives nutzen, PR-Checkliste.

**Was nicht funktioniert:** Das Dokument zu haben. Es wird nicht automatisch gelesen. Weder von Menschen noch von Agents.

**Was funktionieren würde:** PR-Template das die Checkliste direkt enthält. Automatischer Check ob neue Strings in beiden Sprachdateien vorhanden sind. Lint-Regel die `PageShell`-Import prüft.

**Lerneffekt:** Ein Regelwerk ohne System-Backing ist ein Wunschzettel. Erst wenn das System den Merge blockiert bis die Checkliste abgehakt ist, werden die Regeln wirklich eingehalten.

---

## Weiterführend

- **[Agent Engineering Playbook](https://github.com/LanNguyenSi/agent-engineering-playbook)**: vollständige technische Referenz mit Checklisten und Templates
- **[project-forge](https://github.com/LanNguyenSi/project-forge)**: Greenfield-Scaffolding mit integrierten Gates
- **[depsight](https://github.com/LanNguyenSi/depsight)**: Security und Dependency Health für Brownfield

---

Unternehmen skalieren Agents nicht dadurch, dass sie ihnen mehr Freiheit geben, sondern dadurch, dass sie Verantwortung und Systemgrenzen sauber designen.

*Feedback und Beiträge willkommen. Eine erweiterte Referenzversion mit Templates, CI-Snippets und konkreten Policies ist in Arbeit.*

**Autor:** Lan Nguyen Si
**Lizenz:** CC BY 4.0
**Status:** v0.1 | März 2026
