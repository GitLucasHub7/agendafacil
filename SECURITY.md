# Informações sensíveis

Não envie tokens, senhas, chaves privadas, dados de clientes ou valores de segredos em issues, pull requests, logs e comentários.

Este repositório mantém apenas uma configuração demo. A configuração web de um app Firebase é pública por natureza, mas os valores reais do projeto foram omitidos nesta versão. Segurança de dados depende de regras, autenticação e validação no servidor, não de esconder essa configuração.

Os tokens do Mercado Pago e o segredo de assinatura do webhook pertencem ao Secret Manager. Arquivos `.env`, contas de serviço, artefatos dos emuladores e logs estão ignorados. O exemplo `.env.example` contém apenas parâmetros públicos.

Antes de enviar alterações, execute `npm run check:publication` e revise o diff. A verificação cobre padrões conhecidos e arquivos proibidos; não substitui a revisão humana nem garante detectar qualquer segredo possível. Não envie o histórico de uma cópia que já tenha contido informações confidenciais.

Se ocorrer exposição, revogue ou troque a credencial no serviço de origem e trate também o histórico e os artefatos que a contenham. Excluir apenas a linha do arquivo não revoga uma credencial.

Ainda não há um canal privado de reporte de vulnerabilidades configurado. Não publique provas que contenham dados sensíveis; combine um canal privado com o mantenedor antes de compartilhar detalhes.
