---
'@adonis-agora/media': patch
---

`attach` numa collection `single` não destrói mais a mídia anterior quando uma conversion eager falha.

A ordem era: grava bytes → salva registro → **apaga a anterior** → gera as conversions eager. O
docblock do próprio método prometia o contrário ("a failed write leaves the old media intact"), mas
a conversion rodava depois do delete. Um upload que o processador não consegue decodificar — um PNG
truncado, por exemplo — apagava a mídia antiga e então lançava, e como o chamador nunca chegava a
persistir o id novo, o dono ficava **sem nada**.

As conversions eager agora rodam antes do delete, e uma falha nelas reverte a mídia nova inteira
(bytes, conversions já escritas e a linha), deixando a anterior de pé.
