# Estado do lançamento

Atualizado em 25/11/2026. Este repositório usa configurações de exemplo; as credenciais ficam fora do GitHub.

## Entregas verificadas

- [x] Editor, login e rascunhos isolados por usuário.
- [x] Endereço do lançamento definido: https://agendafacil-online.web.app (Firebase Hosting, sem compra de domínio).
- [x] Blaze, orçamento com alertas e App Check exigido nas funções protegidas. O orçamento não limita os gastos automaticamente.
- [x] Mercado Pago com credenciais e notificações separadas para teste e produção; cobrança real habilitada no ambiente publicado.
- [x] Assinatura de teste aprovada, publicação e cancelamento verificados. Isso não comprova uma venda real.
- [x] Agenda com serviços, disponibilidade, prevenção de reservas sobrepostas e cancelamento pelo dono.
- [x] Contato público do estabelecimento para remarcações e cancelamentos; exigido ao salvar uma agenda aberta.
- [x] Páginas iniciais de suporte, privacidade e termos com responsável e e-mail definidos.
- [x] Ajustes mobile e correção do carregamento de “Meus sites”.
- [x] Testes locais e validação contínua no GitHub, sem deploy automático.

## Verificações que continuam abertas

- [ ] Acompanhar a primeira venda real: pagamento, notificação, ativação e publicação. O responsável não precisa comprar a própria assinatura.
- [x] Recebimento e resposta do e-mail de suporte verificados em 25/11/2026, com mensagem de teste e retorno confirmado.
- [ ] Validar recusa e estorno no gateway externo; os testes automatizados desses cenários não substituem a homologação externa.

## Limites atuais

- Teste e produção usam credenciais distintas no mesmo projeto Firebase; não são projetos isolados.
- Cada negócio tem uma agenda compartilhada, sem agendas separadas por profissional.
- Não há envio automático de lembretes por WhatsApp ou e-mail.
- O pagamento dos serviços agendados é combinado com o estabelecimento; a integração cobra a assinatura da plataforma.
- As páginas legais descrevem a versão atual e não representam certificação jurídica.
