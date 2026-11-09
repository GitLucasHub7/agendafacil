# Passo a passo para colocar no ar

**Situação em 09/11/2026:** o caminho de demonstração Spark abaixo já foi executado e o ciclo de rascunhos foi verificado no Firebase. O caminho completo de assinaturas permanece pendente. Nenhuma configuração real do ambiente é distribuída neste repositório.

## Caminho rápido: demonstração sem pagamentos

1. Criar ou selecionar o projeto Firebase de desenvolvimento e habilitar E-mail/Senha e Firestore.
2. Preparar uma cópia de implantação fora deste repositório demo. Preencher a configuração web correta e os aliases locais; manter `APP_MODE=spark`.
3. Executar instalação, testes, verificações de recursos e de ambiente.
4. Revisar e publicar apenas Hosting e regras. Conferir cadastro, login e gravação de rascunhos no domínio publicado.

Isso coloca a demonstração no ar, mas não habilita cobrança, publicação paga ou reservas reais de horários.

## Caminho completo: assinaturas

1. **Faturamento:** vincular uma conta ativa ao projeto e habilitar Blaze. Definir orçamento e alertas; eles não representam teto geral de gastos.
2. **Ambiente de testes:** confirmar que o projeto não recebe clientes reais. Separar produção antes de iniciar atendimento comercial.
3. **Mercado Pago:** a aplicação de Assinaturas e as contas de teste já foram verificadas; a homologação externa continua pendente. Seguir a [preparação do Mercado Pago](MERCADO-PAGO.md), incluindo a distinção entre credenciais da conta de teste e da conta real. Cadastrar `MERCADOPAGO_ACCESS_TOKEN` e `MERCADOPAGO_WEBHOOK_SECRET` por canal seguro no Secret Manager. Não colocar seus valores no GitHub ou no chat.
4. **Configuração:** preencher `APP_BASE_URL` com a origem HTTPS do ambiente. Registrar App Check, testar o cliente e somente então exigir tokens. A configuração de exemplo deste repositório nunca deve ser publicada como configuração real.
5. **Validação local:** executar `npm ci --ignore-scripts`, `npm --prefix functions ci --ignore-scripts`, `npm test`, `npm run check:assets` e o verificador do ambiente escolhido. Revisar o diff final.
6. **Backend de homologação:** publicar as Functions e regras revisadas. Cadastrar a URL efetivamente emitida para `paymentWebhook` no Mercado Pago, com `payment`, `subscription_preapproval` e `subscription_authorized_payment`.
7. **Fluxo externo:** testar criação da assinatura, retorno do checkout, pagamento aprovado/recusado, cancelamento, estorno, reentrega e recuperação. O retorno do navegador nunca deve liberar acesso sozinho.
8. **Publicação:** depois da aceitação dos testes, publicar a interface em Blaze com o backend correspondente. Conferir os arquivos servidos, login, CSP, App Check e criação/publicação de uma página.
9. **Operação:** acompanhar erros, incidentes e custos; configurar retenção/limpeza de artefatos e definir recuperação de dados antes de atender clientes.

Blaze é necessário para implantar as Cloud Functions desta arquitetura. A agenda de reservas reais ainda precisa ser implementada; publicar o construtor não entrega automaticamente essa funcionalidade.

Referências: [Firebase Hosting](https://firebase.google.com/docs/hosting/quickstart), [Cloud Functions](https://firebase.google.com/docs/functions/get-started), [emuladores](https://firebase.google.com/docs/emulator-suite/connect_auth).
