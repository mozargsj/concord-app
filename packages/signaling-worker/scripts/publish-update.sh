#!/usr/bin/env bash
# [2026-08-30, pedido do Mozar] Automatiza o que antes eram ~6 passos manuais feitos à mão depois
# de cada tag vX.Y.Z: baixar os artefatos do build de CI, subir pro R2 (canal de quem já tem o
# app instalado, decisions.md §0.5) e avisar quem está com o app aberto agora (canal de push,
# UpdatesBroadcaster) — o passo que ficou esquecido na v0.0.84 e motivou este script existir.
#
# Uso: ./scripts/publish-update.sh 0.0.85
#
# Pré-requisito: packages/signaling-worker/.dev.vars com ADMIN_SECRET=<valor> (gitignored, nunca
# comitado — mesmo arquivo que `wrangler dev` já usa pra secrets locais). Sem isso, o script sobe
# os artefatos normalmente mas pula o passo de notificação com um aviso, em vez de falhar.
set -euo pipefail

VERSION="${1:?uso: publish-update.sh <versão, ex. 0.0.85>}"
TAG="v${VERSION}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "==> Achando o run de CI da tag $TAG..."
RUN_ID=$(gh run list --workflow=release.yml --json databaseId,headBranch,status,conclusion,event \
  --jq "[.[] | select(.event == \"push\")] | .[0].databaseId")
# gh run list não filtra por tag diretamente — confirma que a tag do run mais recente bate,
# em vez de assumir. Evita publicar artefato errado se o release mais recente não for este.
# [Corrigido, 2026-11-22] Compara a tag do run (headBranch), não o título: o GitHub corta o
# displayTitle em ~70 caracteres, e a versão no fim da mensagem do commit some ("... 0…").
RUN_TAG=$(gh run view "$RUN_ID" --json headBranch --jq '.headBranch')
if [[ "$RUN_TAG" != "$TAG" ]]; then
  echo "ERRO: o run de CI mais recente ($RUN_ID, \"$RUN_TAG\") não parece ser da versão $VERSION." >&2
  echo "Rode 'gh run list --workflow=release.yml' e confirme antes de tentar de novo." >&2
  exit 1
fi

STATUS=$(gh run view "$RUN_ID" --json status --jq '.status')
if [[ "$STATUS" != "completed" ]]; then
  echo "ERRO: run $RUN_ID ainda não terminou (status: $STATUS). Espere o build de CI concluir." >&2
  exit 1
fi

echo "==> Baixando artefatos do run $RUN_ID..."
gh run download "$RUN_ID" -n update-artifacts -D "$TMP_DIR"

ARTIFACT_VERSION=$(grep -m1 '^version:' "$TMP_DIR/latest.yml" | awk '{print $2}')
if [[ "$ARTIFACT_VERSION" != "$VERSION" ]]; then
  echo "ERRO: latest.yml baixado diz versão $ARTIFACT_VERSION, esperava $VERSION." >&2
  exit 1
fi

echo "==> Subindo pro R2 (concord-media/updates/)..."
cd "$WORKER_DIR"
# [Corrigido, 2026-11-22] latest.yml por último: é ele que anuncia a versão. Subido antes, uma
# falha no meio deixava os apps vendo a versão nova com o instalador antigo (hash não bate).
npx wrangler r2 object put concord-media/updates/Concord-Setup.exe --file="$TMP_DIR/Concord-Setup.exe" --remote --content-type="application/octet-stream"
npx wrangler r2 object put concord-media/updates/Concord-Setup.exe.blockmap --file="$TMP_DIR/Concord-Setup.exe.blockmap" --remote --content-type="application/octet-stream"
npx wrangler r2 object put concord-media/updates/latest.yml --file="$TMP_DIR/latest.yml" --remote --content-type="application/x-yaml"

echo "==> Confirmando que está servindo..."
SERVED_VERSION=$(curl -s https://signaling.undersoft.tec.br/updates/latest.yml | grep -m1 '^version:' | awk '{print $2}')
if [[ "$SERVED_VERSION" != "$VERSION" ]]; then
  echo "ERRO: signaling.undersoft.tec.br/updates/latest.yml devolveu versão $SERVED_VERSION, esperava $VERSION." >&2
  exit 1
fi
echo "    Confirmado: $VERSION servindo em produção."

echo "==> Notificando clientes já abertos..."
if [[ -f "$WORKER_DIR/.dev.vars" ]] && grep -q '^ADMIN_SECRET=' "$WORKER_DIR/.dev.vars"; then
  ADMIN_SECRET=$(grep '^ADMIN_SECRET=' "$WORKER_DIR/.dev.vars" | cut -d= -f2-)
  RESULT=$(curl -s -X POST https://signaling.undersoft.tec.br/admin/notify-update \
    -H "X-Admin-Secret: $ADMIN_SECRET" \
    -H "Content-Type: application/json" \
    -d "{\"version\":\"$VERSION\"}")
  echo "    $RESULT"
else
  echo "    AVISO: ADMIN_SECRET não encontrado em .dev.vars — pulei a notificação push." >&2
  echo "    Quem já está com o app aberto só vai saber do update reabrindo (checagem de boot)." >&2
fi

echo "==> Pronto: $VERSION publicada no canal de auto-update (R2)."
echo "    Landing page é um comando separado agora: packages/client/scripts/publish-landing-page.sh $VERSION"
