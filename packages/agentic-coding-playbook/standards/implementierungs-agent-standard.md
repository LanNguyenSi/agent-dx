# Implementierungs-Agent-Standard

**Status:** Entwurf  
**Sprache:** Deutsch  
**Companion:** [English](implementation-agent-standard.md)

Ein leichter operativer Standard für Implementierungs-Agents.

## Zweck

Nutze diesen Standard, wenn ein Team möchte, dass ein Implementierungs-Agent Änderungen unter expliziten Qualitätsgrenzen liefert, statt sich auf informelle Erwartungen zu verlassen.

## Dieses Dokument ist operativ

Dieses Dokument ist die operative Schwester zum übergeordneten Referenzpapier:

- [Review Levels and Implementation Standards (English)](../references/review-levels-and-implementation-standards.md)
- [Review-Stufen und Qualitätsstandards (Deutsch)](../references/review-stufen-und-qualitaetsstandards.md)

Die Referenz erklärt das Modell.
Dieser Standard ist für die tägliche Implementierung gedacht.

## Struktur

### Rolle

Definiere den Implementierungsbereich klar.

Beispiele:
- Next.js-Implementierungsagent
- Symfony-Implementierungsagent
- Backend-Integrationsagent
- Frontend-Refactor-Agent

### Erforderliche Skills

Liste die Fähigkeiten auf, die der Agent zuverlässig einsetzen soll.

Beispiele:
- Testen
- Sicherheit
- API-Gestaltung
- Fehlerbehandlung
- Refactoring-Disziplin

### Standard

Der Implementierungs-Agent muss die folgenden Regeln einhalten, sofern sie nicht explizit aufgehoben werden.

## Quality-First Implementation Rules

1. Implementiere nur den angeforderten Scope.
2. Bevorzuge die kleinste saubere Änderung.
3. Folge bestehenden Patterns und Architekturgrenzen.
4. Verändere keine Security-, Auth- oder Infrastruktur-Logik ohne expliziten Auftrag.
5. Ergänze oder aktualisiere Tests, wenn Verhalten verändert wird.
6. Markiere Annahmen, Risiken und Unsicherheiten explizit.
7. Vermeide ungefragte Refactorings, Dependencies oder Nebenänderungen.
8. Übergib nur Änderungen, die technisch sauber reviewbar sind.

## Review-Erwartung

Dieser Standard ist am stärksten, wenn er mit Review kombiniert wird.

Empfohlene Paarung:
- interne Tools: mindestens normales Review
- Produktion und Brownfield-Systeme: bevorzugt rigoroses Review

## Übergabe-Erwartung

Ein Implementierungs-Agent, der nach diesem Standard arbeitet, sollte bei der Übergabe benennen:

- was geändert wurde
- welche Annahmen getroffen wurden
- was getestet wurde
- welche Risiken oder Unsicherheiten offen bleiben
- was Reviewer als Nächstes verifizieren sollten
