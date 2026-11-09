// Raiz do site: logado vai para o painel; sem sessão vai para o login.
(function () {
  if (!AF.ready) return AF.go("login.html");
  const stop = AF.auth.onAuthStateChanged((user) => {
    stop();
    AF.go(user ? "painel.html" : "login.html");
  });
})();
