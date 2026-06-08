<!-- Vorlage. In dein Repo kopieren und ausfüllen. Tool-agnostisch. -->

# Task-Slicing-Plan

Aus einer größeren Spec kleine, sichere, unabhängig reviewbare Tasks machen.

## Quell-Spec

- Spec-Datei:
- Zugehöriges Issue:
- Menschlicher Owner:

## Slicing-Prinzipien

- Kleine Diffs bevorzugen
- Tests vor Implementierung bevorzugen, wenn das Verhalten bekannt ist
- Discovery von Implementierung trennen
- Spekulative Refactorings vermeiden
- Abhängigkeiten explizit machen
- Jeden Task wo möglich unabhängig reviewbar halten

## Tasks

### Task 1: <kurzer imperativer Titel>

- **Ziel:**
- **Scope:**
- **Out of Scope:**
- **Umsetzungsnotizen:**
- **Evals:**
- **Risiko:** Low / Medium / High
- **Abhängigkeiten:** Keine / Task N
- **Agent-Prompt:**

  ```text
  Implementiere nur diesen Task.
  Löse keine späteren Tasks.
  Führe keine unbezogenen Refactorings durch.
  Führe die gelisteten Evals aus und berichte die Ergebnisse.
  ```

## Empfohlene Ausführungsreihenfolge

1. ...

## Parallelisierbare Tasks

- ...

## Stop-Conditions

- unklare Interface-Ownership
- fehlschlagende bestehende Tests ohne Bezug zum Task
- fehlende Abhängigkeit
- widersprüchliche Specs
- sicherheitskritisches Verhalten nicht spezifiziert
