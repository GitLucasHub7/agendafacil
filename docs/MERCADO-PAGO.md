# Mercado Pago: homologação de assinaturas

## Estado verificado em 19/11/2026

- Firebase Blaze ativo; nove Functions de desenvolvimento publicadas.
- Credenciais da conta de vendedor de teste e assinatura do webhook cadastradas no Secret Manager, sem exposição dos valores.
- Webhook assinado recebido e validado pelo backend.
- Checkout executado com comprador distinto e cartão fictício: aprovação de R$ 21,90 exibida pelo Mercado Pago.
- A aprovação revelou uma falha de consulta: a busca de faturas enviava limite de 50 registros, rejeitado pela API. A tentativa inicial com limite de 20 ainda falhou na consulta por pagamento. O provider passou a omitir o limite explícito e respeitar a paginação retornada pela API, com falha segura quando a resposta está incompleta.
- Os 211 testes unitários passaram, incluindo regressão da paginação. Após publicar a correção, a sincronização autenticada reconheceu a assinatura como ativa e publicou o site de teste. O cancelamento foi confirmado no gateway e no Firebase. Checkout aprovado sozinho não libera acesso.
- As sete verificações negativas do backend passaram após o deploy: chamadas sem autenticação e webhook sem assinatura retornam 401. Após a correção final, as dez notificações deste teste ficaram processadas. Cinco eventos de pagamento que haviam esgotado/falhado as tentativas foram reenfileirados de forma restrita e recuperados pelo job autenticado. Recusa e estorno ainda exigem homologação externa.
- A assinatura de teste está cancelada; a conta e o site de teste foram preservados porque o período de acesso concedido ainda está vigente. A proteção de exclusão não foi contornada.
- A interface publicada foi ativada em Blaze para homologação, com avisos de pagamentos de teste no painel e no checkout. Os 18 arquivos servidos foram conferidos. O vendedor permanece sendo uma conta de teste; lançamento comercial ainda não concluído.

IDs de contas/transações, credenciais e capturas do painel não são publicados neste repositório.

## Contrato usado pelo código

A assinatura é criada sem plano pré-cadastrado, com estado `pending`, e o comprador segue o `init_point` retornado pelo Mercado Pago. O valor atual definido no servidor é R$ 21,90 por site/mês, em BRL. Não é necessário criar um plano avulso no painel para esse fluxo.

O servidor controla preço e referência do site. O retorno do checkout não libera acesso: a conciliação consulta o Mercado Pago e confirma a cobrança. Os testes locais existentes não substituem a homologação externa.

## Próximas etapas para homologação

1. Blaze e alertas de orçamento habilitados. Manter a interface pública em Spark até concluir a validação do backend de testes.
2. Para Assinaturas, seguir a orientação exibida no painel: usar as **credenciais produtivas da conta de vendedor de teste**, e um comprador de teste distinto. A palavra “produtivas” nesse contexto não significa usar a conta real do vendedor; o prefixo do token sozinho não identifica um ambiente seguro.
3. Inserir `MERCADOPAGO_ACCESS_TOKEN` somente no Secret Manager por canal seguro. Não copiar valores para o chat, frontend, Git, documentação ou logs.
4. Coordenar a publicação de `paymentWebhook` e a configuração da assinatura secreta. Usar a URL HTTPS efetivamente confirmada pelo deploy. Não cadastrar uma URL estimada, uma página do Hosting ou um endpoint ainda inexistente. Não desativar a validação da assinatura para facilitar essa etapa.
5. No painel correto para a aplicação de teste, configurar os eventos de assinatura e pagamento. O código processa `subscription_preapproval`, `subscription_authorized_payment` e `payment`. O painel atualmente agrupa opções como **Planos e assinaturas** e **Pagamentos (legacy)**; conferir os eventos efetivos ao salvar.
6. Guardar a assinatura gerada em `MERCADOPAGO_WEBHOOK_SECRET` e disponibilizar a versão correta à função. Nunca marcar essa etapa como concluída antes de validar uma entrega assinada.
7. Executar o fluxo com vendedor, comprador e cartão de teste: criação, aprovação/recusa, retorno, cancelamento, reentrega e conciliação. Confirmar que assinaturas de teste remanescentes foram canceladas.
8. Somente após a homologação preparar a aplicação/credenciais reais e a publicação comercial, conforme [Lançamento](LANCAMENTO.md).

Credenciais e backend de testes já estão disponíveis. As etapas abaixo servem como roteiro de reprodução; a aceitação final depende da conciliação, cancelamento e demais cenários externos. Não usar cobranças reais nesta homologação.

Referência da solução: [Assinaturas — Mercado Pago](https://www.mercadopago.com.br/developers/pt/docs/subscriptions/landing).
