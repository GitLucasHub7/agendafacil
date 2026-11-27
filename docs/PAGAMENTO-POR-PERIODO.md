# Pagamento por período

Implementação de 27/11/2026. A assinatura recorrente continua usando `/preapproval`. A opção manual usa Checkout Pro (`/checkout/preferences`), com valor fixado no servidor em R$ 21,90 e sem cadastro de cobrança recorrente.

## Fluxo

- Editor e painel levam à página `pagamento.html?site=...`; só o botão final cria o checkout.
- `createSubscription` exige autenticação, App Check, e-mail confirmado e propriedade do site. O cliente escolhe somente site e modalidade (`recurring` ou `manual`).
- A modalidade é persistida na mesma transação que reserva o endereço e bloqueia criações simultâneas.
- Os identificadores `af_manual_...` são referências locais. Nunca são enviados à API `/preapproval`.
- O adaptador reutiliza o registro de períodos pagos e a publicação transacional. Cada pagamento possui um identificador de cobrança separado; repetir o webhook não acrescenta outro mês.
- O webhook `payment` existente valida a assinatura e consulta o pagamento no servidor. Conferimos referência, ambiente, moeda e valor antes de conceder acesso.
- Pix/boleto pendente não libera acesso. O mês começa na confirmação; estorno/contestação revoga o crédito. Após vencer, não há carência nem renovação automática. A renovação manual fica disponível após o vencimento e a atualização do estado.
- Uma preferência expira em dois dias. Checkout expirado pode ser renovado mantendo o histórico da mesma assinatura. Um boleto já emitido depende do estado e prazo retornados pelo Mercado Pago.
- Ao trocar a modalidade, o servidor consulta o pagamento anterior. Uma cobrança paga não é substituída. Pendências manuais precisam ser canceladas no gateway antes da troca.
- Resultado de criação incerto é recuperado por referência e geração da preferência. Falha de busca não autoriza criar outra cobrança silenciosamente.

## Verificação de segurança

- Tokens continuam no Secret Manager; nenhum dado de cartão passa pelo aplicativo.
- Retorno ao painel não confirma pagamento. A consulta ao gateway e o webhook controlam a publicação.
- URL de retorno validada como HTTPS público; URLs de checkout restritas a HTTPS em domínio Mercado Pago.
- Trava persistida de criação, referência externa gerada pelo servidor e registro idempotente de pagamentos.
- Testes e produção mantêm credenciais distintas.

## Evidências e limites

Testes automatizados cobrem boleto pendente, aprovação, notificação repetida, estorno, vencimento sem carência, renovação, moeda/ambiente/valor incorretos, recuperação e troca após pagamento. Há teste do SDK real com transporte HTTP simulado para conferir os endpoints de Preferences e Payments.

O validador estático do plugin não reconhece o cliente injetado do adaptador e reporta ausência da rota de criação. A chamada real `Preference.create` é coberta pelo teste de contrato do SDK; não foi substituída por uma rota Express artificial.

Não há certificação ou avaliação oficial de qualidade do Mercado Pago nesta entrega. Testes automatizados não comprovam compensação bancária de boleto nem uma compra real. A disponibilidade final de cada meio deve ser conferida no checkout da conta recebedora.

## Conferência publicada em 27/11/2026

Após o cadastro da chave pelo titular, o checkout mensal foi reaberto pelo AgendaFácil: Pix, cartão e boleto exibidos, total R$ 21,90, sem login do comprador no Mercado Pago. A chave não foi incluída no código ou na documentação. Nenhuma compra foi concluída ou boleto emitido. Deploy concluído; 260 testes locais passaram e a validação do GitHub passou no commit 7eb7549.


### Pendência após revisão do Pix

A disponibilidade visual do Pix não comprova sua operação. Após o usuário atualizar o e-mail para outra conta, o botão Gerar código permaneceu desabilitado. A seleção do Pix foi refeita pela interface e o bloqueio persistiu, sem mensagem de validação ou erro no console nessa sessão. Nenhum pagamento foi gerado. Causa não determinada; requer investigação do checkout pelo Mercado Pago antes de considerar o fluxo validado.

