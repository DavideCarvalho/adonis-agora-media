---
'@adonis-agora/media': patch
---

Corrige dois pontos onde este pacote ainda capturava um singleton do `@adonisjs/core` via `import`
de módulo em vez de recebê-lo do provider — o mesmo formato de dual-package hazard que já havia
derrubado o `Database` do Lucid em produção (ver o changeset `lucid-string-token`), só que agora nos
singletons `app` e `router` do próprio core.

**1 — `app` capturado eager em `services/main.ts` e `single_file_store.ts`.** Ambos faziam
`import app from '@adonisjs/core/services/app'` no topo do módulo. Esse binding só é preenchido via
`setApp()` chamado pelo Ignitor da app hospedeira; se a árvore de dependências contiver DUAS cópias
físicas de `@adonisjs/core` (pnpm workspace hoisting, pins divergentes, ou até a mesma versão
resolvida sob peer-sets diferentes), a cópia que este pacote importa nunca recebe esse `setApp()` — o
`app` fica `undefined` e qualquer uso quebra com um `Cannot read properties of undefined` opaco.

A correção segue o padrão já usado pelo `@adonis-agora/authz` (`services/booted_app.ts`): o
`MediaProvider.register()` agora captura a instância de `ApplicationService` que a própria aplicação
lhe entrega — que é sempre a cópia correta, seja qual for a duplicação na árvore — e a expõe via um
módulo interno (`src/services/booted_app.ts`) para `services/main.ts` e `single_file_store.ts`
lerem. Nenhuma mudança de API: `media.library.attach(...)` e as funções `storeSingleFile` /
`removeSingleFile` / `isSingleFileStoreAvailable` continuam idênticas por fora.

**2 — `router` resolvido eager e usado síncrono em `providers/media_provider.ts`.** O provider
importava `router` de `@adonisjs/core/services/router` no topo do módulo e chamava `router.get(...)`
/ `router.post(...)` direto dentro de `boot()`. Esse serviço específico só é atribuído dentro de um
hook `app.booted(...)` no próprio módulo `services/router.ts` do core — que dispara estritamente
DEPOIS do `boot()` de todos os providers. Ou seja, mesmo numa árvore com uma única cópia do core,
usar esse import de forma síncrona em `boot()` já é uma corrida contra o próprio mecanismo que o
preenche; numa árvore duplicada o problema se soma ao caso 1.

A montagem das rotas (`/media/uploads/direct/*`, `/media/uploads/proxy`, `/media/uploads/tus/*`)
agora é adiada para dentro de `app.booted(...)` — o mesmo padrão já documentado e em produção no
`DashboardProvider` do `@adonis-agora/durable`. Verificado que isso é seguro para o ciclo de vida do
Adonis: os hooks `booted` de TODOS os providers disparam antes do `Server#boot()` do
`@adonisjs/http-server` (que roda dentro de `app.start()`) chamar `router.commit()` — o último ponto
em que rotas ainda podem ser adicionadas. Dentro do hook, o `router` é resolvido pelo container
(`app.container.make('router')`) a partir do `this.app` do provider, imune à duplicação da mesma
forma que o caso 1.

Nenhuma mudança de comportamento observável: as mesmas rotas são montadas, só que um instante mais
tarde no boot (antes do servidor HTTP subir, nunca depois).

Também adicionado `prepack` ao `package.json` do pacote publicável, espelhando o `build`.
