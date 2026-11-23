# Agenda e preparação de produção

A agenda permite configurar serviços e durações, dias de atendimento e bloqueios de datas. Reservas usam transações para impedir sobreposição e chaves de idempotência para evitar duplicações. O proprietário lista e cancela reservas pelo painel; visitantes não recebem os dados pessoais das demais reservas.

Esta versão tem uma agenda por estabelecimento. Os preços dos serviços são informativos; não há cobrança desses serviços pelo AgendaFácil, notificações automáticas ou calendários separados por profissional.

## Configuração por ambiente

O repositório contém somente configuração demo. Para produção, use uma cópia de implantação e os arquivos de configuração do seu próprio projeto.

- Registre o aplicativo no App Check com reCAPTCHA Enterprise e restrinja os domínios. No cliente, configure APPCHECK_SITE_KEY (chave pública) e APPCHECK_PROVIDER=enterprise.
- Valide a navegação legítima antes de exigir ENFORCE_APP_CHECK=true. Não habilite tokens de depuração em domínios públicos.
- PAYMENT_ENVIRONMENT=test mantém criação de assinaturas no vendedor de teste; live seleciona produção. LIVE_SELLER_ID identifica publicamente o vendedor esperado e é conferido no servidor.
- Secret Manager: MERCADOPAGO_ACCESS_TOKEN e MERCADOPAGO_WEBHOOK_SECRET pertencem a teste; MERCADOPAGO_LIVE_ACCESS_TOKEN e MERCADOPAGO_LIVE_WEBHOOK_SECRET pertencem à aplicação real. Nunca coloque seus valores no Git ou no navegador.
- Configure paymentWebhook na aplicação de teste e livePaymentWebhook na aplicação real. Cada endpoint valida a assinatura e o ambiente antes de aplicar os estados.
- Assinaturas existentes preservam seu ambiente. Um checkout pendente de outro ambiente não deve ser oferecido como checkout real.

O simulador pode enviar um identificador inexistente. A validação da assinatura e a entrega do evento não comprovam pagamento. A aceitação final exige uma assinatura existente, confirmação no gateway e publicação no sistema. Testes automatizados não devem efetuar cobranças reais.

## Verificação

Execute as suítes unitárias e de emulador e confira a publicação contra segredos. Os testes incluem sobreposição de reservas, idempotência, autorização, isolamento dos ambientes financeiros e visibilidade dos estados da página pública. O fluxo publicado foi exercitado com dados fictícios; a primeira cobrança real completa permanece pendente.
