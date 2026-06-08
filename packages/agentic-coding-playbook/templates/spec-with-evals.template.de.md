<!-- Vorlage. In dein Repo kopieren und ausfüllen. Tool-agnostisch. -->

# Spec mit Evals

> Eine Spec gibt Richtung. Evals geben Feedback. Gates geben Vertrauen.

## Ziel

Beschreibe das gewünschte Ergebnis in ein bis zwei Absätzen.

## Fachlicher Kontext

Warum ist diese Änderung wichtig? Wer ist betroffen? Welches Risiko wird
reduziert oder welche Fähigkeit wird ergänzt?

## Scope

Die Änderung darf berühren:

- ...

## Out of Scope

Die Änderung darf nicht berühren:

- ...

## Risk Tier

- Tier: 1 (autonom) / 2 (assistiert) / 3 (verboten)
- Begründung:
- Menschlicher Owner:
- Erforderliches Review-Level: normal / rigoros / explizite Freigabe

(Siehe `./risk-classification.template.de.md` und
`../references/review-stufen-und-qualitaetsstandards.md`.)

## Architektur-Constraints

- ...

## Security-Constraints

- ...

## Erwartetes Verhalten

Beschreibe das Verhalten konkret.

## Beispiele

### Beispiel 1

- Gegeben:
- Wenn:
- Dann:

## Evals

Woran wird korrektes Verhalten erkannt? Jede Eval ist eine prüfbare Aussage,
keine vage Absicht.

### Eval 1: <Name>

- Gegeben:
- Wenn:
- Dann:
- Umsetzungshinweis: Unit-Test / Integrationstest / Contract-Test / statische
  Prüfung / manuelle Verifikation

## Quality Gates

- [ ] Build läuft durch
- [ ] Tests laufen durch
- [ ] Statische Analyse läuft durch
- [ ] Lint läuft durch
- [ ] Security-Scan bei Bedarf berücksichtigt

## Stop-Conditions

Stoppe und fordere menschliches Review an, wenn:

- Änderungen an öffentlichen APIs nötig sind
- Auth, Berechtigungen, Krypto, Secrets oder Produktionskonfiguration betroffen sind
- eine Datenbank-Migration nötig ist
- bestehende Tests aus unbezogenen Gründen fehlschlagen
- die Spec der bestehenden Architektur widerspricht
- die Aufgabe das Lesen von Secrets oder Produktionsdaten erfordert

## Übergabe-Anforderungen

Der implementierende Agent muss berichten:

- Was geändert wurde
- Welche Dateien geändert wurden
- Welche Evals ergänzt oder aktualisiert wurden
- Welche Kommandos ausgeführt wurden
- Was fehlgeschlagen ist
- Annahmen
- Verbleibende Risiken
