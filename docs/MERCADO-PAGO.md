# Mercado Pago: preparação e limites

## Estado verificado em 09/11/2026

- Aplicação existente com produto **Assinaturas**.
- Descrição da aplicação e categoria **Serviços de TI** salvas no painel.
- Contas de teste de vendedor e comprador já existentes; não foi necessário criar duplicatas.
- Nenhum webhook configurado no painel consultado.
- Nenhum pagamento externo ou assinatura de teste executado nesta etapa.
- Firebase permanece no Spark; as Functions de pagamento ainda não foram publicadas.

Essas verificações confirmam a preparação da conta, não o funcionamento dos pagamentos de ponta a ponta. IDs de conta, credenciais e capturas do painel não são publicados neste repositório.

## Contrato usado pelo código

A assinatura é criada sem plano pré-cadastrado, com estado `pending`, e o comprador segue o `init_point` retornado pelo Mercado Pago. O valor atual definido no servidor é R$ 21,90 por site/mês, em BRL. Não é necessário criar um plano avulso no painel para esse fluxo.

O servidor controla preço e referência do site. O retorno do checkout não libera acesso: a conciliação consulta o Mercado Pago e confirma a cobrança. Os testes locais existentes não substituem a homologação externa.

## Próximas etapas para homologação

1. Habilitar o backend de testes no Firebase com Blaze, orçamento e limites revisados, mantendo a interface pública em Spark até concluir a validação.
2. Para Assinaturas, seguir a orientação exibida no painel: usar as **credenciais produtivas da conta de vendedor de teste**, e um comprador de teste distinto. A palavra “produtivas” nesse contexto não significa usar a conta real do vendedor; o prefixo do token sozinho não identifica um ambiente seguro.
3. Inserir `MERCADOPAGO_ACCESS_TOKEN` somente no Secret Manager por canal seguro. Não copiar valores para o chat, frontend, Git, documentação ou logs.
4. Coordenar a publicação de `paymentWebhook` e a configuração da assinatura secreta. Usar a URL HTTPS efetivamente confirmada pelo deploy. Não cadastrar uma URL estimada, uma página do Hosting ou um endpoint ainda inexistente. Não desativar a validação da assinatura para facilitar essa etapa.
5. No painel correto para a aplicação de teste, configurar os eventos de assinatura e pagamento. O código processa `subscription_preapproval`, `subscription_authorized_payment` e `payment`. O painel atualmente agrupa opções como **Planos e assinaturas** e **Pagamentos (legacy)**; conferir os eventos efetivos ao salvar.
6. Guardar a assinatura gerada em `MERCADOPAGO_WEBHOOK_SECRET` e disponibilizar a versão correta à função. Nunca marcar essa etapa como concluída antes de validar uma entrega assinada.
7. Executar o fluxo com vendedor, comprador e cartão de teste: criação, aprovação/recusa, retorno, cancelamento, reentrega e conciliação. Confirmar que assinaturas de teste remanescentes foram canceladas.
8. Somente após a homologação preparar a aplicação/credenciais reais e a publicação comercial, conforme [Lançamento](LANCAMENTO.md).

As etapas que dependem de credenciais e backend continuam pendentes. Não cadastrar cobranças reais para comprovar uma integração ainda em preparação.

Referência da solução: [Assinaturas — Mercado Pago](https://www.mercadopago.com.br/developers/pt/docs/subscriptions/landing).
