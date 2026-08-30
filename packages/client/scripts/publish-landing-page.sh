#!/usr/bin/env bash
# [2026-08-30, pedido do Mozar] Publicar o instalador na landing page (concordProject) e publicar
# o canal de auto-update (R2, packages/signaling-worker/scripts/publish-update.sh) viraram dois
# comandos independentes de propósito — antes release.yml fazia a publicação na landing page
# sozinho, sem ordem explícita separada pra esse pedaço, misturado no mesmo job do build. Este
# script consome o MESMO artefato de CI (`update-artifacts`) que o do auto-update usa — não builda
# nada de novo, só publica o instalador já pronto no release "latest" do repo da landing page.
#
# Uso: ./scripts/publish-landing-page.sh 0.0.91
set -euo pipefail

VERSION="${1:?uso: publish-landing-page.sh <versão, ex. 0.0.91>}"
TAG="v${VERSION}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "==> Achando o run de CI da tag $TAG..."
RUN_ID=$(gh run list --workflow=release.yml --json databaseId,headBranch,status,conclusion,event \
  --jq "[.[] | select(.event == \"push\")] | .[0].databaseId")
RUN_TAG=$(gh run view "$RUN_ID" --json displayTitle --jq '.displayTitle')
if [[ "$RUN_TAG" != *"$VERSION"* ]]; then
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

echo "==> Publicando no release \"latest\" de mozargsj/concordProject..."
gh release delete latest --repo mozargsj/concordProject --yes --cleanup-tag || true
gh release create latest "$TMP_DIR/Concord-Setup.exe" \
  --repo mozargsj/concordProject \
  --title "Concord — instalador mais recente" \
  --notes "Publicado a partir de $TAG."

echo "==> Pronto: $VERSION publicada na landing page."
