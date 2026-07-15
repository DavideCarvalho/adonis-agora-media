---
'@adonis-agora/media': patch
---

Conserta o `node ace configure @adonis-agora/media`, que nunca funcionou em nenhuma versão.

Dois bugs independentes, os dois provados contra o compilador real:

- **O hook não era alcançável.** O `configure.ts` existia e o `package.json` exportava
  `./configure`, mas o ace chega no hook pelo entry point principal — e o `src/index.ts` não o
  reexportava. `import('@adonis-agora/media').configure` era `undefined`.
- **Nenhum stub renderizava.** O tempura trata crase como início de template literal, inclusive
  dentro de comentário. Os 3 stubs usavam crase no docblock e morriam com `Unexpected identifier`
  antes de gerar qualquer arquivo. As crases dos comentários viraram aspas simples; os template
  literals de verdade do código do stub continuam intactos.

Nada no build pegava isso: stub é dado, o tsc nunca o compila, e nenhum teste os tocava. Agora
um teste renderiza todo stub pelo tempura e afirma que o index reexporta o `configure`.
