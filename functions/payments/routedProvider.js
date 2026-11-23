// Old subscriptions remain attached to the test seller. New subscriptions carry
// their environment explicitly; no token prefix is used to guess the account.
function createRoutedProvider({ db, providerFor, fallbackEnvironment = 'test' }) {
  const valid = value => { if (!['test', 'live'].includes(value)) throw new Error('Ambiente de pagamento inválido.'); return value; };
  valid(fallbackEnvironment);
  async function byReference(reference) {
    const snap = await db.collection('subscriptions').doc(String(reference)).get();
    if (!snap.exists) throw new Error('Assinatura local não encontrada.');
    return providerFor(valid(snap.data().paymentEnvironment || 'test'));
  }
  async function byPreapproval(id) {
    const result = await db.collection('subscriptions').where('mpPreapprovalId', '==', String(id)).get();
    if (result.docs.length > 1) throw new Error('Referência de cobrança ambígua.');
    return providerFor(valid(result.docs.length ? result.docs[0].data().paymentEnvironment || 'test' : fallbackEnvironment));
  }
  return {
    async createPreapproval(args) { return (await byReference(args.externalReference)).createPreapproval(args); },
    async findPreapprovalByExternalReference(args) { return (await byReference(args.externalReference)).findPreapprovalByExternalReference(args); },
    async getPreapproval(id) { return (await byPreapproval(id)).getPreapproval(id); },
    async cancelPreapproval(id) { return (await byPreapproval(id)).cancelPreapproval(id); },
    async searchInvoices(args) { return (args.preapprovalId ? await byPreapproval(args.preapprovalId) : providerFor(fallbackEnvironment)).searchInvoices(args); },
    async getPayment(id) { return providerFor(fallbackEnvironment).getPayment(id); },
    async getInvoice(id) { return providerFor(fallbackEnvironment).getInvoice(id); },
  };
}
module.exports = { createRoutedProvider };
