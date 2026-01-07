# Política de Privacidade - Vaal Trade Assistant

**Última atualização:** 7 de janeiro de 2026

## 1. Introdução

A Vaal Trade Assistant ("extensão") é uma extensão de navegador que ajuda jogadores de Path of Exile 2 a realizar buscas rápidas de comércio. Esta política de privacidade descreve como a extensão coleta, usa e protege suas informações.

## 2. Informações Coletadas

### 2.1 Dados Armazenados Localmente

A extensão armazena os seguintes dados **apenas no seu computador local**:

- **Identificador de Sessão (POESESSID)**: Token fornecido pelo usuário para autenticar requisições à API de comércio do Path of Exile
- **Preferências do Usuário**: Idioma preferido, tipo de comércio (Compra Instantânea, Pessoalmente, Qualquer um), filtros de preço mínimo e máximo
- **Histórico de Buscas**: Até 20 buscas recentes (nome do item, tipo, liga e timestamp)
- **Estatísticas de Uso**: Contagem de buscas realizadas e itens pesquisados
- **Dados em Cache**: Tabelas de estatísticas de itens, gems e queries de busca do Path of Exile 2

**Nenhum desses dados é transmitido para servidores terceirizados.**

### 2.2 Dados Não Coletados

A extensão **NÃO coleta**:
- Informações pessoais (nome, email, endereço, etc.)
- Dados bancários ou de pagamento
- Credenciais de conta (apenas o token de sessão fornecido pelo usuário)
- Dados de navegação ou histórico do navegador
- Informações de identificação pessoal

## 3. Como Usamos as Informações

Os dados armazenados localmente são usados apenas para:

1. **Autenticar requisições**: O POESESSID é enviado apenas para os servidores oficiais de Path of Exile (pathofexile.com)
2. **Personalizar experiência**: Aplicar preferências de idioma e filtros de busca do usuário
3. **Melhorar performance**: Cachear dados estáticos para reduzir requisições à API
4. **Mostrar histórico**: Permitir que você repita ou revise buscas anteriores
5. **Exibir estatísticas**: Mostrar informações sobre suas atividades de busca

## 4. Requisições de Rede

A extensão se comunica com dois domínios:

### 4.1 poe.ninja
- **Motivo**: Buscar dados de preços e estatísticas de itens do Path of Exile 2
- **Dados enviados**: Nenhum dado pessoal, apenas requisições GET a APIs públicas
- **Dados recebidos**: Preços de itens e tabelas de estatísticas
- **Política de privacidade**: https://poe.ninja/privacy

### 4.2 pathofexile.com
- **Motivo**: Realizar buscas na API oficial de comércio do Path of Exile 2
- **Dados enviados**: POESESSID (fornecido pelo usuário) e parâmetros de busca (nome/tipo do item)
- **Dados recebidos**: Resultados da busca de itens
- **Política de privacidade**: https://www.pathofexile.com/privacy

**Essas comunicações são diretas e nenhum terceiro tem acesso a essas requisições.**

## 5. Segurança dos Dados

### 5.1 Proteção Local
- Todos os dados são armazenados no `chrome.storage.local`, que é isolado e criptografado pelo navegador Chrome
- Nenhum dado é enviado para servidores de terceiros
- Seus dados permanecem no seu computador

### 5.2 Segurança do POESESSID
- Você controla totalmente seu token de sessão
- A extensão não o compartilha com ninguém
- Você pode revogar o acesso a qualquer momento limpando os dados da extensão
- O token expira automaticamente quando você faz logout da conta Path of Exile

## 6. Direitos do Usuário

Você tem total controle sobre seus dados:

- **Acessar**: Abra a extensão e visualize suas preferências, histórico e configurações
- **Modificar**: Altere idioma, filtros de preço, POESESSID a qualquer momento
- **Deletar**: Limpe todos os dados locais através das opções da extensão
- **Desinstalar**: Remova a extensão a qualquer momento para deletar todos os dados

## 7. Contato e Suporte

Se tiver dúvidas sobre esta política de privacidade ou sobre como seus dados são tratados, você pode:

- Abrir uma issue no repositório GitHub do projeto
- Entrar em contato através dos canais oficiais do Path of Exile

## 8. Alterações na Política

Esta política de privacidade pode ser atualizada ocasionalmente. Recomendamos revisar periodicamente para se manter informado sobre como protegemos suas informações.

## 9. Conformidade Legal

Esta extensão é desenvolvida por fãs da comunidade Path of Exile e não é afiliada, endossada ou mantida pela Grinding Gear Games.

Ao usar a Vaal Trade Assistant, você concorda com esta Política de Privacidade.

---

**Path of Exile® é uma marca registrada da Grinding Gear Games.**
