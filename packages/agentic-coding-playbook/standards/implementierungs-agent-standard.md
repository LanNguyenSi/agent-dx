# Implementierungs-Agent-Standard

Ein leichter operativer Standard für implementierungsorientierte Coding-Agents.

## Zweck

Nutze diesen Standard, wenn ein Team möchte, dass ein Implementierungs-Agent Änderungen unter expliziten Qualitätsgrenzen liefert, statt sich auf informelle Erwartungen zu verlassen.

## Struktur

### Rolle

Definiere den Implementierungsbereich klar.

Beispiele:
- Next.js Implementer
- Symfony Implementer
- Backend Integrations Implementer
- Frontend Refactor Implementer

### Erforderliche Skills

Liste die Fähigkeiten auf, die der Agent zuverlässig einsetzen soll.

Beispiele:
- Testing
- Security
- Failure Handling
- API Design
- Refactoring Discipline
- Clean Code

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

## Handoff-Erwartung

Ein Implementierungs-Agent, der nach diesem Standard arbeitet, sollte beim Handoff benennen:

- was geändert wurde
- welche Annahmen getroffen wurden
- was getestet wurde
- welche Risiken oder Unsicherheiten offen bleiben
- was Reviewer als Nächstes verifizieren sollten
