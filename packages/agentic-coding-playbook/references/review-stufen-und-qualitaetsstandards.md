# Review-Stufen und Qualitätsstandards für Implementierungs-Agents

Dieses Dokument ergänzt das Agentic Coding Playbook um zwei eng zusammenhängende Themen:

1. den Unterschied zwischen keiner Prüfung, normalem Review und rigorosem Review
2. die Notwendigkeit expliziter Qualitätsstandards für Implementierungs-Agents

Es ist die deutschsprachige Schwesterfassung des englischen Referenzdokuments zu Review Levels and Implementation Standards.

## Warum das wichtig ist

Starke Teams brauchen nicht nur gute Agents, sondern gute Prüfmechanismen.

Der Unterschied zwischen Agentic Coding ohne Review, mit Review und mit rigorosem Review ist oft größer als der Unterschied zwischen den verwendeten Modellen.

Ebenso wichtig ist ein klarer Qualitätsstandard für Implementierungs-Agents: Nicht nur *was* ein Agent tun soll, sondern *wie* er implementieren soll.

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
- **mit Review** → der Agent optimiert auf „eine prüfbare Antwort“
- **mit rigorosem Review** → das System optimiert auf „eine verantwortbare Änderung“

Das ist ein riesiger Unterschied.

## Was starke Teams zusätzlich brauchen

In der Praxis ist das genau das, was starke Teams bauen sollten:

Nicht nur Skills für den Agenten, sondern einen klaren Qualitätsstandard für Implementation.

Ein belastbares Modell besteht aus drei Teilen:

## 1. Role

Beispiel:

- Symfony Implementer
- Next.js Implementer
- Backend Integrations Implementer

Die Rolle beschreibt den primären Verantwortungsbereich des Agents.

## 2. Skill

Beispiel:

- Clean Code
- Testing
- Security
- Refactoring Discipline
- API Design
- Failure Handling

Skills beschreiben, *worin* der Agent besonders gut und verlässlich arbeiten soll.

## 3. Standard

Beispiel:

- Quality-First Implementation Rules
- Safe Change Rules
- Brownfield Change Discipline

Der Standard definiert, *wie* der Agent Änderungen umsetzen darf und welche Qualitätsmaßstäbe dabei gelten.

## Warum dieses Modell stärker ist

Das Modell **Role + Skill + Standard** ist deutlich belastbarer als bloß:

> „Du bist Senior Engineer.“

Denn es trennt sauber:

- **wofür** der Agent zuständig ist
- **welche Fähigkeiten** er einsetzen soll
- **welchen Qualitätsregeln** er folgen muss

Genau diese Trennung macht Implementierungs-Agents in echten Teams verlässlicher.

## Beispiel für einen Qualitätsstandard für Implementierungs-Agents

### Quality-First Implementation Rules

1. Implementiere nur den angeforderten Scope.
2. Bevorzuge die kleinste saubere Änderung.
3. Folge bestehenden Patterns und Architekturgrenzen.
4. Verändere keine Security-, Auth- oder Infrastruktur-Logik ohne expliziten Auftrag.
5. Ergänze oder aktualisiere Tests, wenn Verhalten verändert wird.
6. Markiere Annahmen, Risiken und Unsicherheiten explizit.
7. Keine ungefragten Refactorings, Dependencies oder Nebenänderungen.
8. Liefere nur Ergebnisse ab, die technisch prüfbar sind.

## Praktische Schlussfolgerung

Für Agentic Coding reicht es nicht, nur gute Modelle zu wählen.

Entscheidend ist:

- welches Review-Niveau verwendet wird
- welcher Qualitätsstandard für Implementation gilt
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
