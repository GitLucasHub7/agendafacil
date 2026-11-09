# Arquitetura

O frontend usa HTML, CSS e JavaScript, com Firebase Authentication e Firestore. Não há etapa de compilação da interface.

## Dois modos explícitos

- **Spark:** o navegador salva apenas o conteúdo de rascunhos privados, respeitando as regras do Firestore. Não há cobrança nem publicação paga.
- **Blaze:** as operações financeiras e publicação passam por Cloud Functions. O modo só deve ser ativado após configurar e validar os serviços externos.

`APP_MODE` ausente ou inválido bloqueia a inicialização. O exemplo entregue usa Spark e um projeto demo. A prévia local troca o projeto antes da inicialização dos SDKs e falha sem recorrer ao ambiente real.

## Separação dos dados

`sites` guarda conteúdo privado; `publicSites` contém apenas a versão pública. Assinaturas, cobranças, notificações, reservas de endereço e incidentes têm permissões específicas. O cliente não pode declarar uma cobrança aprovada nem alterar os campos financeiros.

## Assinaturas e recuperação

O servidor mantém o plano e o valor da assinatura, gera a referência externa e controla a criação em transação. Uma criação incerta não libera automaticamente uma segunda cobrança. O webhook valida a assinatura HMAC e consulta o estado atual no gateway. Rotinas de reconciliação e reprocessamento tratam falhas transitórias.

Os testes usam um gateway simulado e, em parte, transações reais no emulador. A compatibilidade externa depende de homologação com contas de teste.

## Execução

Node 22 nas Functions; Java 21 nos emuladores. O código prepara mínimo de zero instâncias e máximo de três por função, com limite mais baixo nas rotinas agendadas. Esses limites não são um teto financeiro e não substituem orçamento, monitoramento e testes de carga.
