# Cine Local

Catálogo e player para filmes baixados, com compressão sem perda visível e volume acima de 100%.

## Como usar
**Instalar:** rode `dist/CineLocal-Setup-1.1.0.exe`. Ele cria atalhos na Área de Trabalho e no Menu Iniciar.
Na primeira vez, clique em **📁 Pasta** e escolha onde estão seus filmes (subpastas também entram).
No app instalado, configurações, cache e login do Telegram ficam em `%APPDATA%\Cine Local`.

**Desenvolvimento:** `iniciar.bat` ou `npm start` abre o app direto do código. `npm run web` roda a versão no navegador (http://localhost:8765).
**Gerar o instalador de novo:** `npm run dist`. O ícone é gerado por `npm run icon` (build/icon.png).

## Recursos
- **Catálogo**: miniatura, título/ano extraídos do nome do arquivo, duração, resolução, codecs, tamanho, busca e ordenação.
- **Player**: continua de onde parou; legenda `.srt`/`.vtt` com o mesmo nome do filme é carregada sozinha.
- **Mini player** (botão 🗗 ou tecla `P`): janela pequena que fica por cima dos outros programas, com legenda,
  volume amplificado, realce de diálogos e barra de tempo. Arraste pelo topo, redimensione pelas bordas;
  `⤢` (ou `Esc`/duplo clique) volta para o app no mesmo ponto, `✕` para. Ela lembra posição e tamanho.
  Na versão de navegador, o botão usa o Picture in Picture padrão (sem legenda).
- **Volume até 800%**, com limitador que evita distorção. O volume fica salvo por filme.
  **Realçar diálogos** (tecla `D`) aproxima falas baixas de explosões altas.
  Atalhos: `↑/↓` volume, `←/→` 10 s, `Espaço` pausa, `F` tela cheia, `Esc` fecha.
- **Reduzir tamanho**: recodifica só o vídeo em H.265 (CRF 20, 10 bits = visualmente idêntico);
  áudios e legendas são copiados sem alteração. Gera `nome.compacto.mkv` ao lado do original.
  Se o resultado não ficar menor, é descartado. “Manter só o compacto” move o original para `_originais` (nada é apagado).

## Baixar do Telegram (📥 Telegram)
1. Na primeira vez, crie sua chave em https://my.telegram.org → *API development tools* e cole o `api_id` e o `api_hash`.
2. Entre com seu número; o código chega no próprio app do Telegram (e a senha, se você usa verificação em duas etapas).
3. Escolha um canal/grupo/conversa e clique em **Baixar** no vídeo, ou cole links `https://t.me/...` (um por linha).

O download pede vários pedaços do arquivo ao mesmo tempo (ajustável em **Conexões**, padrão 8), o que costuma ser
bem mais rápido que o app oficial. Dá para pausar e continuar de onde parou, até depois de fechar o app.
Marque **Comprimir ao terminar** para o filme já entrar na fila de compressão.

⚠️ `config.json` e `telegram.session` dão acesso à sua conta do Telegram: não compartilhe esses arquivos.
