# Review-Stufen und Qualitätsstandards

**Status:** Entwurf  
**Sprache:** Deutsch  
**Companion:** [English](review-levels-and-implementation-standards.md)

Dieses Referenzdokument erläutert zwei eng zusammenhängende Ideen, die die Qualität von Agentic Coding in der Praxis stark beeinflussen:

1. den Unterschied zwischen keiner Prüfung, normalem Review und rigorosem Review
2. die Notwendigkeit expliziter Qualitätsstandards für Implementierungs-Agents

Es ist als konzeptionelle Ergänzung zum Agentic Coding Playbook gedacht, nicht als operativer Standard selbst.

## Warum das wichtig ist

Starke Teams brauchen nicht nur gute Agents, sondern gute Prüfmechanismen.

Der Unterschied zwischen Agentic Coding ohne Review, mit Review und mit rigorosem Review ist oft größer als der Unterschied zwischen den verwendeten Modellen.

Ebenso wichtig ist ein klarer Qualitätsstandard für Implementierungs-Agents: nicht nur *was* ein Agent tun soll, sondern *wie* er implementieren soll.

## 1. Ohne Review

Der Agent liefert direkt ein Ergebnis und niemand prüft es ernsthaft.

### Typische Merkmale

- wirkt schnell und beeindruckend
- ist oft lokal plausibel, aber global nicht sauber
- versteckte Fehler bleiben leicht unentdeckt
- Annahmen, Seiteneffekte und Randfälle werden selten sauber geprüft

### Was man häufig sieht

- Code erfüllt den Happy Path, aber nicht die echten Betriebsbedingungen
- bestehende Architektur wird unabsichtlich verletzt
- Naming, Grenzen, Zuständigkeiten und Security sind inkonsistent
- Tests wirken vorhanden, prüfen aber das Falsche oder zu wenig

### Ergebnis

- gut für Prototyping, Ideation, Wegwerfen
- riskant für Brownfield, Produktion, sicherheitsrelevante Systeme

## 2. Mit Review

Der Agent liefert, danach schaut ein Mensch oder ein zweiter Agent drüber.

### Typische Merkmale

- offensichtliche Fehler werden deutlich reduziert
- Stil, Lesbarkeit und grobe Architekturverstöße fallen eher auf
- Missverständnisse in der Aufgabe werden oft noch rechtzeitig erkannt

### Was besser wird

- Compile- und Syntaxfehler
- einfache Logikfehler
- schlechte Benennung
- doppelte Logik
- fehlende Basis-Tests
- grobe Sicherheits- oder Validierungsprobleme

### Aber

- vieles bleibt noch oberflächlich
- Review wird oft zu „sieht okay aus“
- tiefe Systemfehler, implizite Annahmen und Integrationsprobleme rutschen weiter durch

### Ergebnis

- deutlich besser als ohne Review
- für viele interne Tools schon brauchbar
- aber noch nicht automatisch produktionsreif

## 3. Mit rigorosem Review

Hier wird nicht nur der Code angeschaut, sondern die gesamte Behauptung des Ergebnisses geprüft.

### Das heißt

- stimmt die Umsetzung gegen die Spec?
- stimmt sie gegen Architekturregeln?
- stimmt sie gegen Sicherheitsanforderungen?
- stimmt sie gegen reale Randfälle?
- stimmt sie gegen Betrieb, Deployment, Observability und Ownership?

### Rigoroses Review heißt meist

- Code Review
- Spec Review
- Test Review
- Gegenbeispiele und Failure Modes
- Architektur- und Security-Checks
- reale oder realitätsnahe Verifikation

### Was dadurch besser wird

- falsche Annahmen werden sichtbar
- „funktioniert bei mir“-Lösungen fliegen auf
- Agent-Halluzinationen in APIs, Contracts oder Libraries werden entdeckt
- Brownfield-Schäden werden stark reduziert
- die Lösung wird wartbarer und verantwortbarer

### Ergebnis

- langsamer
- teurer im Moment
- aber oft massiv günstiger über Lebensdauer, besonders in echten Systemen

## Das eigentliche Muster

Man kann es grob so sehen:

- **ohne Review** → der Agent optimiert auf „eine plausible Antwort“
- **mit Review** → das System optimiert auf „eine prüfbare Antwort“
- **mit rigorosem Review** → das System optimiert auf „eine verantwortbare Änderung“

Das ist ein riesiger Unterschied.

## Was starke Teams zusätzlich brauchen

Starke Teams brauchen nicht nur leistungsfähige Agents, sondern ein klares Qualitätsmodell für Implementierung.

Ein belastbares Modell besteht aus drei Teilen:

## 1. Rolle

Beispiele:

- Symfony-Implementierungsagent
- Next.js-Implementierungsagent
- Backend-Integrationsagent

Die Rolle beschreibt den primären Verantwortungsbereich des Agents.

## 2. Skill

Beispiele:

- Testen
- Sicherheit
- API-Gestaltung
- Fehlerbehandlung
- Refactoring-Disziplin

Skill beschreibt, worin der Agent besonders verlässlich arbeiten soll.

## 3. Standard

Beispiele:

- Quality-First Implementation Rules
- Safe Change Rules
- Brownfield Change Discipline

Der Standard definiert, wie der Agent Änderungen umsetzen darf und welche Qualitätsmaßstäbe gelten.

## Warum dieses Modell stärker ist

Das Modell **Rolle + Skill + Standard** ist deutlich belastbarer als bloß:

> „Du bist Senior Engineer.“

Denn es trennt sauber:

- wofür der Agent zuständig ist
- welche Fähigkeiten er einsetzen soll
- welchen Qualitätsregeln er folgen muss

Genau diese Trennung macht Implementierungs-Agents in echten Teams verlässlicher.

## Was dieses Dokument ist, und was nicht

Dieses Dokument ist ein **Referenz- und Einordnungsdokument**.
Es erklärt das Modell und begründet, warum es sinnvoll ist.

Für die operative Nutzung siehe die eigentlichen Standards:

- [Implementation Agent Standard (English)](../standards/implementation-agent-standard.md)
- [Implementierungs-Agent-Standard (Deutsch)](../standards/implementierungs-agent-standard.md)

## Praktische Schlussfolgerung

Für Agentic Coding reicht es nicht, nur gute Modelle zu wählen.
Entscheidend ist:

- welches Review-Niveau verwendet wird
- welcher Qualitätsstandard für Implementierung gilt
- welche Rollen, Skills und Grenzen dem Agenten vorgegeben werden

Die eigentliche Reife zeigt sich also nicht nur im Output des Agents, sondern in der Kombination aus:

- **Agent**
- **Review**
- **Standard**

## Merksätze

**Ohne Review:** schnell, aber fragil.

**Mit Review:** brauchbar, aber nicht tief abgesichert.

**Mit rigorosem Review:** langsamer, aber verantwortbar.

Und für Implementierungs-Agents:

**Qualität vor Geschwindigkeit. Präzision vor Umfang. Respekt vor Bestand vor Optimierungsdrang.**
