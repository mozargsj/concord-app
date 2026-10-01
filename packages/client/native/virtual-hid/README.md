# Virtual HID (driver + Windows Service) — o que falta e o contrato

Este diretório documenta a parte **privilegiada** do controle remoto por Virtual HID
(`Concord_Virtual_HID_Controle_Remoto.md`, seções 6, 7, 21, 22 e decisão 12). **Não há código de
driver nem de serviço aqui**: nenhum dos dois pode ser compilado, assinado ou instalado sem o
ambiente descrito abaixo, e driver não verificado não deve ser publicado.

## O que já existe e está verificado (lado do Concord)

| Peça | Onde | Verificação |
|---|---|---|
| Descritores HID (teclado boot-compatível de 8 bytes, mouse absoluto 0..32767 com 5 botões, wheel e AC Pan, relatório de 7 bytes) | `src/common/hidReports.ts` | `node src/common/hidReports.test.ts` |
| Conversão evento do protocolo → relatório HID (modificadores, até 6 teclas, rollover error, botões, posição absoluta, wheel/pan de uso único) | `src/common/hidReports.ts` | idem (inclui Ctrl+Shift+Esc e as demais combinações da spec) |
| Backend por named pipe + seleção automática + fallback para SendInput + fim de sessão se o service cair | `src/main/virtualHidBackend.ts`, `src/main/inputInjector.ts` | `node scripts/virtualHid.check.cjs` (service falso) |

## Protocolo do pipe (o service deve implementar exatamente isto)

Pipe: `\\.\pipe\concord-virtual-hid`. Uma linha JSON (UTF-8) por mensagem.

```text
service -> cliente, logo ao conectar:  {"hello":"concord-virtual-hid","v":1}
cliente -> service:                    {"d":"kbd","r":"<8 bytes em hex>"}
                                       {"d":"mouse","r":"<7 bytes em hex>"}
                                       {"d":"config","buttons":1..5,"horizontalWheel":true|false}   (opcional)
```

`config` chega uma vez por sessão e descreve só o que o hardware real do controlador consegue produzir
(número de botões, roda horizontal): o service **pode** moldar o dispositivo virtual a isso ou ignorar a
mensagem. Nunca contém VID/PID, nome, fabricante ou serial de nenhum dispositivo, e o dispositivo virtual
mantém a identidade própria do Concord (spec, seção 7 e decisão 13).

Requisitos do service (segurança, spec 21, 22, 40):

1. **Só repassa relatórios.** Valida `d` ∈ {`kbd`, `mouse`} e o tamanho exato do relatório; descarta o resto.
   Nunca executa comando, abre arquivo ou instala nada a partir do que recebe.
2. **ACL do pipe** restrita ao usuário da sessão interativa (SID); recusa outros clientes. Validar PID/caminho
   do cliente é desejável.
3. **Um cliente por vez.** Segunda conexão é recusada enquanto há uma ativa.
4. **Fecha o pipe ⇒ solta tudo.** Ao perder o cliente por qualquer motivo, envia ao driver relatórios neutros
   (teclado `00×8`, mouse sem botões) antes de qualquer outra coisa. Isso é o Input Reset do lado do service.
5. **Troca de sessão/logoff/suspensão:** mesmo comportamento do item 4.
6. **Secure Desktop/UAC — obrigatório, não opcional:** o driver injeta ao nível do dispositivo e **alcançaria**
   o desktop seguro. O service deve **recusar** relatórios enquanto o desktop de entrada não for o `Default`
   (`OpenInputDesktop` + nome; tela de bloqueio, UAC e Winlogon ficam fora do alcance), conforme a spec
   (seção 20, decisão 14).
7. **Ctrl+Alt+Del — obrigatório, não opcional:** um teclado virtual HID é um teclado real para o Windows e
   **dispararia** a Secure Attention Sequence (o `SendInput` não dispara). O service deve **repetir** o filtro de
   `src/common/inputPolicy.ts`: manter o estado das teclas segurando e **nunca encaminhar a tecla que completaria**
   Ctrl+Alt+Delete (Delete ou Delete do numpad, qualquer ordem, qualquer lado dos modificadores), descartando
   também o "solta" correspondente. O filtro do cliente é só a primeira linha; esta é a que vale.

## O que precisa ser feito, e por quê não foi feito aqui

| Item | Requisito do ambiente |
|---|---|
| Driver UMDF2 com o Virtual HID Framework (VHF): um dispositivo de teclado e um de mouse com os descritores acima, recebendo relatórios do service | **WDK** instalado (cabeçalhos `km`/`wdf`/`vhf.h` — não estão nesta máquina) |
| Assinatura | **Certificado EV** + conta no **Hardware Dev Center (Partner Center)** para atestação; em desenvolvimento, `bcdedit /set testsigning on` (exige Secure Boot desligado) |
| Windows Service (host do pipe) | .NET ou C++; instalado por operação **elevada** |
| Instalador | Hoje o NSIS é por usuário e sem admin. O driver e o service exigem instalação elevada (`perMachine` ou instalador à parte via `nsis.include`); o auto-update por usuário **não atualiza** driver/service — versionar o service e checar no handshake (`v`) |
| Smart App Control | Driver e service não assinados serão bloqueados; só a atestação resolve para usuários finais |
| Pointer absoluto no desktop virtual | **Verificar ao vivo** se o Windows mapeia a posição absoluta do dispositivo para todos os monitores ou só para o principal (o `SendInput` usa `MOUSEEVENTF_VIRTUALDESK`; o equivalente HID pode exigir um descritor/feature diferente) |

## Como ativar quando existir

Nada a configurar: ao iniciar uma sessão como Controlled, `prepareBackend()` tenta o pipe por ~400 ms;
respondeu o `hello` esperado ⇒ Virtual HID, senão ⇒ SendInput. `CONCORD_INPUT_BACKEND=sendinput` força o
fallback para comparar os dois caminhos.

Observação: `isInputAvailable()` ainda depende do addon `input-control` (também usado pelo atalho
Ctrl+Shift+Pause). Uma máquina só com o service e sem o addon precisaria de outra fonte para o atalho de
parada antes de aceitar controle.
