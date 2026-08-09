# Understat–FPL 球员映射审计日志

> Historical evidence snapshot generated before the Data Platform v3 hard cut. Runtime names are
> now `bridge.entity_links` and unified season-keyed `fpl.*` tables. The decisions and counts below
> are preserved as audit evidence; this file is not the current schema or ingestion contract. See
> `docs/understat-pipeline.md` for the authoritative runtime design.

- 生成时间：2026-08-09T00:40:05.664Z
- 规则版本：`understat-fpl-player-name-v3`
- 处理顺序：2526 → 2425 → 2324 → 2223 → 2122 → 2021 → 1920 → 1819 → 1718 → 1617 → 1516 → 1415
- exact normalized full name 不单独记录；所有非 exact 决策均在本文记录。
- consumer 只应读取 `bridge.entity_links.status IN (auto_verified, manual_verified)`。

## 判定规则

- `exact`：FPL `first_name + second_name` 与 Understat `source_name` 经 Unicode、重音和标点归一化后完全一致。
- `high`：唯一的稳定姓名变体、昵称、反序/缩写、姓名子集，或同队且首名接近、姓氏共享的正式姓名扩展；且有球队/位置、赛季统计或跨赛季已审核结果支持；自动写为 `auto_verified`，但本文保留记录并抽样复核。
- `low`：候选不唯一、同队同姓/同名冲突、无法从现有 FPL 档案确定，或只有弱模糊相似度；不写入 verified link，等待人工逐条确认。
- 逐赛季向下继承只复用已经接受的 Understat player id ↔ FPL code；一旦新赛季出现冲突，保持 low，不静默重绑。

## 逐赛季结果

| 赛季 | FPL 球员 | Understat 球员 | exact | 向下继承 | high 非 exact | manual | low（不含 unmatched） | unmatched | 状态 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2526 | 841 | 537 | 422 | 0 | 115 | 0 | 0 | 0 | database-verified |
| 2425 | 804 | 562 | 176 | 343 | 43 | 0 | 0 | 0 | database-verified |
| 2324 | 865 | 570 | 160 | 383 | 27 | 0 | 0 | 0 | database-verified |
| 2223 | 778 | 554 | 130 | 401 | 23 | 0 | 0 | 0 | database-verified |
| 2122 | 737 | 537 | 135 | 386 | 16 | 0 | 0 | 0 | database-verified |
| 2021 | 713 | 524 | 111 | 396 | 17 | 0 | 0 | 0 | database-verified |
| 1920 | 666 | 515 | 100 | 402 | 13 | 0 | 0 | 0 | database-verified |
| 1819 | 624 | 505 | 120 | 373 | 12 | 0 | 0 | 0 | database-verified |
| 1718 | 647 | 515 | 128 | 378 | 9 | 0 | 0 | 0 | database-verified |
| 1617 | 683 | 524 | 135 | 372 | 17 | 0 | 0 | 0 | database-verified |
| 1516 | 550 | 550 | 535 | 0 | 15 | 0 | 0 | 0 | database-verified |
| 1415 | 531 | 531 | 517 | 0 | 14 | 0 | 0 | 0 | database-verified |

合计：3755 条非 exact 决策，其中自动 high 3755 条、manual 0 条、low 0 条；12 个赛季均已写入 verified link。

## High 非 exact 全量日志

| 赛季 | Understat id | Understat 名称 | FPL code | FPL 名称 | 类型 | 置信度 | 分数 | 规则 |
| --- | ---: | --- | ---: | --- | --- | --- | ---: | --- |
| 2526 | 87 | Joelinton | 180974 | Joelinton Cássio Apolinário de Lira | name-variant | high | 1.03 | web-name-exact |
| 2526 | 668 | Idrissa Gueye | 80801 | Idrissa Gana Gueye | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 900 | Adama Traoré | 159533 | Adama Traoré Diarra | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 987 | Joseph Gomez | 171287 | Joe Gomez | name-variant | high | 1.045 | team-and-shared-name-tokens |
| 2526 | 1228 | Bruno Fernandes | 141746 | Bruno Borges Fernandes | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 1257 | Alisson | 116535 | Alisson Becker | name-variant | high | 1.06 | team-and-shared-name-tokens |
| 2526 | 1679 | Dominic Solanke | 154566 | Dominic Solanke-Mitchell | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 2182 | Jefferson Lerma | 152551 | Jefferson Lerma Solís | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 2203 | Emiliano Buendía | 195546 | Emiliano Buendía Stati | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 2248 | Casemiro | 61256 | Carlos Henrique Casimiro | name-variant | high | 1.03 | web-name-exact |
| 2526 | 2496 | Rodri | 220566 | Rodrigo 'Rodri' Hernandez Cascante | name-variant | high | 1.051 | team-and-shared-name-tokens |
| 2526 | 3635 | Bernardo Silva | 165809 | Bernardo Mota Veiga de Carvalho e Silva | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 4105 | Raúl Jiménez | 102057 | Raúl Jiménez Rodríguez | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 4401 | Emiliano Martinez | 98980 | Emiliano Martínez Romero | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 5061 | Kepa | 109745 | Kepa Arrizabalaga Revuelta | name-variant | high | 1.06 | team-and-shared-name-tokens |
| 2526 | 5304 | Mikel Merino | 195384 | Mikel Merino Zazón | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 5543 | Gabriel Jesus | 205651 | Gabriel Fernando de Jesus | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 5613 | Gabriel | 226597 | Gabriel dos Santos Magalhães | name-variant | high | 1.03 | season-stats-supported:web-name-exact |
| 2526 | 6026 | Richarlison | 212319 | Richarlison de Andrade | name-variant | high | 1.03 | web-name-exact |
| 2526 | 6122 | Douglas Luiz | 230046 | Douglas Luiz Soares de Paulo | name-variant | high | 1.03 | web-name-exact |
| 2526 | 6382 | Pedro Neto | 247632 | Pedro Lomba Neto | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 6912 | Pedro Porro | 441164 | Pedro Porro Sauceda | name-variant | high | 1.03 | web-name-exact |
| 2526 | 6935 | Naif Aguerd | 210494 | Nayef Aguerd | name-variant | high | 1.048 | team-and-shared-name-tokens |
| 2526 | 6986 | Hamed Junior Traore | 424044 | Hamed Traorè | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 7080 | Matheus Cunha | 430871 | Matheus Santos Carneiro da Cunha | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 7134 | Marc Cucurella | 179268 | Marc Cucurella Saseta | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 7281 | Diogo Dalot | 216051 | Diogo Dalot Teixeira | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 7298 | Ben White | 198869 | Benjamin White | name-variant | high | 1.041 | team-and-shared-name-tokens |
| 2526 | 7332 | Max Kilman | 214048 | Maximilian Kilman | name-variant | high | 1.039 | team-and-shared-name-tokens |
| 2526 | 7365 | Lucas Paquetá | 224024 | Lucas Tolentino Coelho de Lima | name-variant | high | 1.06 | team-and-shared-name-tokens |
| 2526 | 7432 | Reinildo | 434399 | Reinildo Mandava | name-variant | high | 1.03 | web-name-exact |
| 2526 | 7526 | Martín Zubimendi | 481655 | Martín Zubimendi Ibáñez | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 7752 | Gabriel Martinelli | 444145 | Gabriel Martinelli Silva | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 7943 | Igor Julio | 223434 | Igor Julio dos Santos de Paulo | name-variant | high | 0.97 | full-name-subset |
| 2526 | 8056 | Arnaud Kalimuendo Muinga | 465680 | Arnaud Kalimuendo | name-variant | high | 1.06 | team-and-shared-name-tokens |
| 2526 | 8094 | Mathis Cherki | 466052 | Rayan Cherki | name-variant | high | 1.035 | team-and-shared-name-tokens |
| 2526 | 8127 | Amad Diallo Traore | 493250 | Amad Diallo | name-variant | high | 1.06 | team-and-shared-name-tokens |
| 2526 | 8272 | João Pedro | 475168 | João Pedro Junqueira de Jesus | name-variant | high | 1.03 | web-name-exact |
| 2526 | 8327 | Bruno Guimarães | 208706 | Bruno Guimarães Rodriguez Moura | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 8489 | Jorge Cuenca | 246301 | Jorge Cuenca Barreno | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 8808 | Wataru Endo | 158983 | Endo Wataru | name-variant | high | 0.99 | unordered-full-name-exact |
| 2526 | 8831 | Iyenoma Destiny Udogie | 487053 | Destiny Udogie | name-variant | high | 1.03 | team-and-shared-name-tokens |
| 2526 | 8845 | Hee-Chan Hwang | 184754 | Hwang Hee-chan | name-variant | high | 1.03 | unordered-full-name-exact |
| 2526 | 8864 | Matthew Cash | 199796 | Matty Cash | name-variant | high | 1.047 | team-and-shared-name-tokens |
| 2526 | 8961 | Rúben Dias | 171314 | Rúben dos Santos Gato Alves Dias | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 8969 | Florentino Luís | 216055 | Florentino Ibrain Morris Luís | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 9021 | Pape Sarr | 482442 | Pape Matar Sarr | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 9024 | Yeremi Pino | 488024 | Yéremy Pino Santos | name-variant | high | 1.055 | team-and-close-first-name-expanded-last-name |
| 2526 | 9098 | Robert Sánchez | 215059 | Robert Lynch Sánchez | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 9451 | Chimuanya Ugochukwu | 503714 | Lesley Ugochukwu | name-variant | high | 1.033 | team-and-shared-name-tokens |
| 2526 | 9453 | Moisés Caicedo | 486672 | Moisés Caicedo Corozo | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 9501 | Fabio Carvalho | 244858 | Fábio Freitas Gouveia Carvalho | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 9512 | Valentino Livramento | 441191 | Tino Livramento | name-variant | high | 1.043 | team-and-shared-name-tokens |
| 2526 | 9676 | David Raya | 154561 | David Raya Martín | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 9740 | José Sá | 149065 | José Malheiro de Sá | name-variant | high | 1.03 | web-name-exact |
| 2526 | 9802 | Nico González | 465694 | Nico González Iglesias | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 9958 | Yerson Mosquera | 501837 | Yerson Mosquera Valdelamar | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 9983 | Beto | 486385 | Norberto Bercique Gomes Betuncal | name-variant | high | 1.03 | web-name-exact |
| 2526 | 10140 | Hugo Bueno | 490721 | Hugo Bueno López | name-variant | high | 1.06 | season-stats-supported:team-and-close-first-name-expanded-last-name |
| 2526 | 10293 | Toti | 510362 | Toti Gomes | name-variant | high | 1.03 | web-name-exact |
| 2526 | 10552 | Alejandro Garnacho | 493105 | Alejandro Garnacho Ferreyra | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 10715 | João Palhinha | 154296 | João Maria Lobo Alves Palhares Costa Palhinha Gonçalves | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 10717 | Rodrigo Muniz | 244042 | Rodrigo Muniz Carvalho | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 10805 | Levi Colwill | 460028 | Levi Samuels Colwill | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 10806 | Kaoru Mitoma | 451340 | Mitoma Kaoru | name-variant | high | 1.03 | unordered-full-name-exact |
| 2526 | 10864 | Marcos Senesi | 221466 | Marcos Senesi Barón | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 10945 | Santiago Bueno | 231480 | Santiago Ignacio Bueno | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 11167 | Chadi Riad | 515621 | Chadi Riad Dnanou | name-variant | high | 1.03 | web-name-exact |
| 2526 | 11231 | Ben Doak | 496208 | Ben Gannon-Doak | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 11297 | Carlos Alcaraz | 502697 | Carlos Alcaraz Durán | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 11384 | João Gomes | 448089 | João Victor Gomes da Silva | name-variant | high | 1.06 | season-stats-supported:team-and-close-first-name-expanded-last-name |
| 2526 | 11504 | Eli Junior Kroupi | 560262 | Junior Kroupi | name-variant | high | 1.035 | team-and-shared-name-tokens |
| 2526 | 11633 | Marc Guiu | 499309 | Marc Guiu Paz | name-variant | high | 1.03 | web-name-exact |
| 2526 | 11735 | Sávio | 510281 | Sávio Moreira de Oliveira | name-variant | high | 1.06 | team-and-shared-name-tokens |
| 2526 | 11763 | Abduqodir Khusanov | 578153 | Abdukodir Khusanov | name-variant | high | 1.057 | team-and-close-first-name-expanded-last-name |
| 2526 | 11766 | Manuel Ugarte | 232112 | Manuel Ugarte Ribeiro | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 11772 | Yehor Yarmolyuk | 508395 | Yehor Yarmoliuk | name-variant | high | 1.04 | team-and-first-name-season-stats-supported |
| 2526 | 11808 | Andrey Santos | 532605 | Andrey Nascimento dos Santos | name-variant | high | 1.03 | web-name-exact |
| 2526 | 11824 | Lucas Pires | 549329 | Lucas Pires Silva | name-variant | high | 1.03 | web-name-exact |
| 2526 | 12032 | Djordje Petrovic | 457569 | Đorđe Petrović | name-variant | high | 1.039 | team-and-shared-name-tokens |
| 2526 | 12094 | Mike Trésor | 437748 | Mike Trésor Ndayishimiye | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 12123 | Murillo | 575476 | Murillo Costa dos Santos | name-variant | high | 1.03 | web-name-exact |
| 2526 | 12168 | Alejandro Jiménez | 551483 | Álex Jiménez Sánchez | name-variant | high | 1.04 | team-and-first-name-season-stats-supported |
| 2526 | 12203 | Treymaurice Nyoni | 591386 | Trey Nyoni | name-variant | high | 1.041 | team-and-shared-name-tokens |
| 2526 | 12358 | Oliver Scarles | 536109 | Ollie Scarles | name-variant | high | 1.045 | team-and-shared-name-tokens |
| 2526 | 12369 | Lucas Perri | 201595 | Lucas Estella Perri | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 12408 | Daniel Muñoz | 247348 | Daniel Muñoz Mejía | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 12410 | Joshua King | 577725 | Josh King | name-variant | high | 1.05 | team-and-shared-name-tokens |
| 2526 | 12595 | Hákon Valdimarsson | 507433 | Hákon Rafn Valdimarsson | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 12756 | Rodrigo Gomes | 483081 | Rodrigo Martins Gomes | name-variant | high | 1.06 | season-stats-supported:team-and-close-first-name-expanded-last-name |
| 2526 | 12766 | Jota Silva | 510500 | João Pedro Ferreira da Silva | name-variant | high | 1.045 | season-stats-supported:team-and-shared-name-tokens |
| 2526 | 12948 | Mateus Fernandes | 551226 | Mateus Gonçalo Espanha Fernandes | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 12963 | Evanilson | 444102 | Francisco Evanilson de Lima Barbosa | name-variant | high | 1.03 | web-name-exact |
| 2526 | 13022 | André | 509291 | André Trindade da Costa Neto | name-variant | high | 1.03 | web-name-exact |
| 2526 | 13026 | Luis Guilherme | 577114 | Luis Guilherme Lira dos Santos | name-variant | high | 1.02 | team-and-close-first-name-expanded-last-name |
| 2526 | 13068 | Morato | 485047 | Felipe Rodrigues da Silva | name-variant | high | 1.03 | web-name-exact |
| 2526 | 13094 | Dário Essugo | 491007 | Dário Luís Essugo | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 13156 | Pedro Lima | 641221 | Pedro Cardoso de Lima | name-variant | high | 1.03 | web-name-exact |
| 2526 | 13200 | Fernando López | 643135 | Fer López González | name-variant | high | 1.04 | team-and-first-name-season-stats-supported |
| 2526 | 13222 | Thiago | 502500 | Igor Thiago Nascimento Rodrigues | name-variant | high | 1.03 | web-name-exact |
| 2526 | 13310 | Jamaldeen Jimoh | 559962 | Jamaldeen Jimoh-Aloba | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 13364 | Diego Gómez | 514254 | Diego Gómez Amarilla | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 13474 | Julio Soler | 575901 | Julio Soler Barreto | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 13715 | Dan Ballard | 223827 | Daniel Ballard | name-variant | high | 1.045 | team-and-shared-name-tokens |
| 2526 | 13718 | Eliezer Mayenda | 564406 | Eliezer Mayenda Dossou | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 13775 | Estêvão | 624773 | Estêvão Almeida de Oliveira Gonçalves | name-variant | high | 1.03 | web-name-exact |
| 2526 | 13778 | Igor Jesus | 482973 | Igor Jesus Maciel da Cruz | name-variant | high | 1.03 | web-name-exact |
| 2526 | 13779 | Jair | 575458 | Jair Paula da Cunha Filho | name-variant | high | 1.06 | team-and-shared-name-tokens |
| 2526 | 13834 | Ao Tanaka | 248056 | Tanaka Ao | name-variant | high | 1.03 | unordered-full-name-exact |
| 2526 | 14017 | John Victor | 221389 | John Victor Maciel Furtado | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2526 | 14030 | Kevin | 560552 | Kevin Santos Lopes de Macedo | name-variant | high | 1.03 | web-name-exact |
| 2526 | 14290 | Pablo | 530335 | Pablo Felipe Pereira de Jesus | name-variant | high | 1.03 | web-name-exact |
| 2526 | 14395 | Rayan | 499604 | Rayan Vitor Simplício Rocha | name-variant | high | 1.03 | web-name-exact |
| 2526 | 14410 | Souza | 616221 | João Victor de Souza Menezes | name-variant | high | 1.03 | web-name-exact |
| 2526 | 14446 | Alysson Edward | 653481 | Alysson Edward Franco da Rocha dos Santos | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2425 | 76 | Fabian Schär | 119471 | Fabian Schär | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 87 | Joelinton | 180974 | Joelinton Cássio Apolinário de Lira | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 181 | Bernd Leno | 80201 | Bernd Leno | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 468 | Callum Wilson | 75115 | Callum Wilson | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 489 | James Milner | 15157 | James Milner | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 500 | Alex Iwobi | 153133 | Alex Iwobi | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 501 | Danny Welbeck | 50175 | Danny Welbeck | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 579 | Nathan Aké | 126184 | Nathan Aké | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 585 | Seamus Coleman | 59949 | Séamus Coleman | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 586 | John Stones | 97299 | John Stones | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 592 | Ross Barkley | 88894 | Ross Barkley | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 603 | Nathaniel Clyne | 57328 | Nathaniel Clyne | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 638 | Kyle Walker | 58621 | Kyle Walker | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 652 | Kieran Trippier | 77794 | Kieran Trippier | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 660 | Ben Davies | 115556 | Ben Davies | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 668 | Idrissa Gueye | 80801 | Idrissa Gueye | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 675 | Jack Grealish | 114283 | Jack Grealish | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 700 | Willian | 47431 | Willian Borges da Silva | name-variant | high | 1.03 | web-name-exact |
| 2425 | 725 | Ola Aina | 159506 | Ola Aina | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 741 | Jordan Pickford | 111234 | Jordan Pickford | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 825 | Adam Smith | 54469 | Adam Smith | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 833 | Virgil van Dijk | 97032 | Virgil van Dijk | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 843 | James Ward-Prowse | 101178 | James Ward-Prowse | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 885 | Kyle Walker-Peters | 158534 | Kyle Walker-Peters | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 900 | Adama Traoré | 159533 | Adama Traoré | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 910 | Harrison Reed | 153366 | Harrison Reed | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 922 | Andreas Pereira | 156689 | Andreas Hoelgebaum Pereira | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2425 | 934 | Axel Tuanzebe | 180804 | Axel Tuanzebe | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 978 | Sam Johnstone | 101982 | Sam Johnstone | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 987 | Joseph Gomez | 171287 | Joe Gomez | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 1006 | Luke Shaw | 106760 | Luke Shaw | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 1024 | Tyrone Mings | 149484 | Tyrone Mings | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 1228 | Bruno Fernandes | 141746 | Bruno Borges Fernandes | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 1245 | Emerson | 109533 | Emerson Palmieri dos Santos | name-variant | high | 1.03 | web-name-exact |
| 2425 | 1250 | Mohamed Salah | 118748 | Mohamed Salah | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 1257 | Alisson | 116535 | Alisson Ramses Becker | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 1297 | Neto | 69752 | Norberto Murara Neto | name-variant | high | 1.02 | season-stats-supported:web-name-exact |
| 2425 | 1389 | Jorginho | 85955 | Jorge Luiz Frello Filho | name-variant | high | 1.03 | web-name-exact |
| 2425 | 1433 | Federico Chiesa | 223541 | Federico Chiesa | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 1537 | Sasa Lukic | 212314 | Saša Lukić | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 1545 | Emil Krafth | 111773 | Emil Krafth | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 1653 | Michael Keane | 106611 | Michael Keane | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 1665 | James Tarkowski | 17761 | James Tarkowski | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 1679 | Dominic Solanke | 154566 | Dominic Solanke-Mitchell | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 1687 | Harry Maguire | 95658 | Harry Maguire | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 1688 | Andrew Robertson | 122798 | Andrew Robertson | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 1776 | Jarrod Bowen | 178186 | Jarrod Bowen | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 1789 | Lewis Cook | 155408 | Lewis Cook | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 1823 | Lucas Digne | 101188 | Lucas Digne | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 2182 | Jefferson Lerma | 152551 | Jefferson Lerma Solís | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 2203 | Emiliano Buendía | 195546 | Emiliano Buendía Stati | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 2248 | Casemiro | 61256 | Carlos Henrique Casimiro | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 2254 | Mateo Kovacic | 91651 | Mateo Kovačić | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 2310 | Alphonse Areola | 84182 | Alphonse Areola | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 2496 | Rodri | 220566 | Rodrigo 'Rodri' Hernandez | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 2517 | Martin Odegaard | 184029 | Martin Ødegaard | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 2958 | Oleksandr Zinchenko | 206325 | Oleksandr Zinchenko | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 3203 | Issa Diop | 219924 | Issa Diop | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 3303 | Ricardo Pereira | 111931 | Ricardo Barbosa Pereira | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2425 | 3635 | Bernardo Silva | 165809 | Bernardo Veiga de Carvalho e Silva | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 3697 | Odsonne Edouard | 199670 | Odsonne Edouard | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 4105 | Raúl Jiménez | 102057 | Raúl Jiménez | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 4120 | Álex Moreno | 106468 | Álex Moreno Lopera | name-variant | high | 1.03 | web-name-exact |
| 2425 | 4401 | Emiliano Martinez | 98980 | Emiliano Martínez Romero | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 4419 | Adam Armstrong | 155511 | Adam Armstrong | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 4456 | Chris Wood | 60689 | Chris Wood | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 5061 | Kepa | 109745 | Kepa Arrizabalaga | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 5136 | Estupiñán | 204214 | Pervis Estupiñán | name-variant | high | 1.03 | web-name-exact |
| 2425 | 5220 | Kai Havertz | 219847 | Kai Havertz | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 5221 | Leon Bailey | 215711 | Leon Bailey | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 5232 | Alexander Isak | 219168 | Alexander Isak | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 5261 | Kevin Danso | 135720 | Kevin Danso | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 5304 | Mikel Merino | 195384 | Mikel Merino | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 5543 | Gabriel Jesus | 205651 | Gabriel Fernando de Jesus | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 5552 | Nick Pope | 98747 | Nick Pope | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 5553 | Declan Rice | 204480 | Declan Rice | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 5555 | Dominic Calvert-Lewin | 177815 | Dominic Calvert-Lewin | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 5584 | Aaron Wan-Bissaka | 214590 | Aaron Wan-Bissaka | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 5590 | Tosin Adarabioyo | 109646 | Tosin Adarabioyo | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 5596 | Harry Wilson | 153682 | Harry Wilson | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 5603 | Aaron Ramsdale | 225321 | Aaron Ramsdale | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 5609 | Yves Bissouma | 227127 | Yves Bissouma | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 5613 | Gabriel | 226597 | Gabriel dos Santos Magalhães | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 5675 | Ismaila Sarr | 232185 | Ismaïla Sarr | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 5682 | Gonçalo Guedes | 181284 | Gonçalo Manuel Ganchinho Guedes | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2425 | 5712 | Diego Carlos | 165659 | Diego Carlos Santos Silva | name-variant | high | 1.03 | web-name-exact |
| 2425 | 5722 | Ibrahim Sangare | 210462 | Ibrahim Sangaré | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 5735 | Jean-Philippe Mateta | 231747 | Jean-Philippe Mateta | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 5786 | Yoane Wissa | 216646 | Yoane Wissa | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 5789 | Boubacar Kamara | 226944 | Boubacar Kamara | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 5956 | Youri Tielemans | 166989 | Youri Tielemans | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 5973 | Kenny Tete | 167074 | Kenny Tete | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6026 | Richarlison | 212319 | Richarlison de Andrade | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6048 | Lewis Dunk | 83299 | Lewis Dunk | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6049 | Solly March | 109345 | Solly March | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6054 | Ederson | 121160 | Ederson Santana de Moraes | name-variant | high | 1.06 | team-and-shared-name-tokens |
| 2425 | 6055 | Phil Foden | 209244 | Phil Foden | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6063 | Jacob Murphy | 114243 | Jacob Murphy | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6080 | Victor Lindelöf | 184667 | Victor Lindelöf | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6098 | Niclas Füllkrug | 91889 | Niclas Füllkrug | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6104 | Will Hughes | 108413 | Will Hughes | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6108 | Rodrigo Bentancur | 202993 | Rodrigo Bentancur | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6145 | Daichi Kamada | 209400 | Daichi Kamada | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6157 | Timothy Castagne | 166477 | Timothy Castagne | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6163 | Nélson Semedo | 200402 | Nélson Cabral Semedo | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2425 | 6174 | Nikola Milenkovic | 227444 | Nikola Milenković | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6219 | Enes Ünal | 168636 | Enes Ünal | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6221 | Pau Torres | 244954 | Pau Torres | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6314 | Joachim Andersen | 174874 | Joachim Andersen | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6326 | Ibrahima Konaté | 204716 | Ibrahima Konaté | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6345 | Jadon Sancho | 209243 | Jadon Sancho | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6382 | Pedro Neto | 247632 | Pedro Lomba Neto | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6456 | Callum Hudson-Odoi | 209046 | Callum Hudson-Odoi | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6482 | Eddie Nketiah | 205533 | Eddie Nketiah | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6492 | Reiss Nelson | 200641 | Reiss Nelson | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6532 | Martin Dubravka | 67089 | Martin Dúbravka | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6552 | Bryan Mbeumo | 446008 | Bryan Mbeumo | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6615 | Trevoh Chalobah | 180736 | Trevoh Chalobah | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6630 | Joe Willock | 200089 | Joe Willock | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6665 | Curtis Jones | 206915 | Curtis Jones | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6674 | Rayan Ait Nouri | 448514 | Rayan Aït-Nouri | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6681 | Harvey Barnes | 201666 | Harvey Barnes | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6722 | Konstantinos Mavropanos | 233963 | Konstantinos Mavropanos | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6756 | Dwight McNeil | 433154 | Dwight McNeil | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6816 | Jean-Clair Todibo | 462116 | Jean-Clair Todibo | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6818 | James Maddison | 172780 | James Maddison | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6820 | David Brooks | 111317 | David Brooks | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6827 | Bobby Reid | 96994 | Bobby De Cordova-Reid | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2425 | 6835 | Tom Cairney | 76357 | Tom Cairney | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6837 | Ryan Sessegnon | 184349 | Ryan Sessegnon | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6852 | Matt Doherty | 87835 | Matt Doherty | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6854 | Diogo Jota | 194634 | Diogo Teixeira da Silva | name-variant | high | 1 | team-and-first-name-season-stats-supported |
| 2425 | 6857 | Morgan Gibbs-White | 222531 | Morgan Gibbs-White | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6885 | Axel Disasi | 220362 | Axel Disasi | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6888 | William Saliba | 462424 | William Saliba | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6903 | Matz Sels | 85633 | Matz Sels | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6912 | Pedro Porro | 441164 | Pedro Porro | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6937 | Georginio Rutter | 463067 | Georginio Rutter | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 6963 | Justin Kluivert | 222683 | Justin Kluivert | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7078 | Sean Longstaff | 180135 | Sean Longstaff | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7080 | Matheus Cunha | 430871 | Matheus Santos Carneiro Da Cunha | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7083 | Christian Nørgaard | 128295 | Christian Nørgaard | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7134 | Marc Cucurella | 179268 | Marc Cucurella Saseta | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7166 | Mathias Jensen | 207283 | Mathias Jensen | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7218 | Cristian Romero | 221632 | Cristian Romero | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7230 | Emile Smith-Rowe | 209289 | Emile Smith Rowe | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7240 | Benoit Badiashile Mukinayi | 242880 | Benoît Badiashile | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7281 | Diogo Dalot | 216051 | Diogo Dalot Teixeira | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7298 | Ben White | 198869 | Benjamin White | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7322 | Bukayo Saka | 223340 | Bukayo Saka | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7332 | Max Kilman | 214048 | Max Kilman | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7352 | Tyler Adams | 200785 | Tyler Adams | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7365 | Lucas Paquetá | 224024 | Lucas Tolentino Coelho de Lima | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7382 | Dan Burn | 78916 | Dan Burn | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7395 | Carlos Vinicius | 245824 | Carlos Vinícius Alves Morais | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2425 | 7420 | Miguel Almirón | 179018 | Miguel Almirón Rejala | name-variant | high | 1.02 | team-and-close-first-name-expanded-last-name |
| 2425 | 7438 | James Garner | 232928 | James Garner | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7546 | Harvey Elliott | 444884 | Harvey Elliott | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7589 | Wesley Fofana | 444463 | Wesley Fofana | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7603 | Marc Guehi | 209036 | Marc Guéhi | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7698 | Leandro Trossard | 116216 | Leandro Trossard | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7702 | Dean Henderson | 172649 | Dean Henderson | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7723 | John McGinn | 122806 | John McGinn | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7726 | Ezri Konsa Ngoyo | 199798 | Ezri Konsa Ngoyo | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7752 | Gabriel Martinelli | 444145 | Gabriel Martinelli Silva | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7753 | James Justin | 220627 | James Justin | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7762 | Jean-Ricner Bellegarde | 231057 | Jean-Ricner Bellegarde | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7768 | Mason Mount | 184341 | Mason Mount | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7814 | Taiwo Awoniyi | 210156 | Taiwo Awoniyi | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7892 | João Félix | 428399 | João Félix Sequeira | name-variant | high | 1.03 | web-name-exact |
| 2425 | 7902 | Matthijs de Ligt | 209365 | Matthijs de Ligt | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7904 | Caoimhin Kelleher | 200720 | Caoimhin Kelleher | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7908 | Marshall Munetsi | 433312 | Marshall Munetsi | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7931 | Takehiro Tomiyasu | 223723 | Tomiyasu Takehiro | name-variant | high | 1.03 | unordered-full-name-exact |
| 2425 | 7943 | Igor Julio | 223434 | Igor Julio dos Santos de Paulo | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 7958 | Sandro Tonali | 432422 | Sandro Tonali | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8044 | Joshua Zirkzee | 458249 | Joshua Zirkzee | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8067 | Reece James | 225796 | Reece James | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8127 | Amad Diallo Traore | 493250 | Amad Diallo | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8129 | Riccardo Calafiori | 466075 | Riccardo Calafiori | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8150 | Anthony Gordon | 232826 | Anthony Gordon | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8204 | Neco Williams | 215136 | Neco Williams | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8214 | Tyrick Mitchell | 244723 | Tyrick Mitchell | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8224 | William Smallbone | 214466 | Will Smallbone | name-variant | high | 1.047 | team-and-shared-name-tokens |
| 2425 | 8252 | Nicolás Domínguez | 250199 | Nicolás Domínguez | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8260 | Erling Haaland | 223094 | Erling Haaland | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8267 | Guido Rodríguez | 197024 | Guido Rodríguez | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8272 | João Pedro | 475168 | João Pedro Junqueira de Jesus | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8285 | Sander Berge | 207189 | Sander Berge | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8288 | Tomas Soucek | 215439 | Tomáš Souček | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8291 | Daniel Podence | 200600 | Daniel Castelo Podence | name-variant | high | 1.06 | season-stats-supported:team-and-close-first-name-expanded-last-name |
| 2425 | 8327 | Bruno Guimarães | 208706 | Bruno Guimarães Rodriguez Moura | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8379 | Alexis Mac Allister | 243016 | Alexis Mac Allister | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8384 | Armando Broja | 440323 | Armando Broja | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8393 | Omar Marmoush | 438234 | Omar Marmoush | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8430 | Chris Richards | 427623 | Chris Richards | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8476 | Jarrad Branthwaite | 480455 | Jarrad Branthwaite | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8489 | Jorge Cuenca | 246301 | Jorge Cuenca Barreno | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8497 | Cole Palmer | 244851 | Cole Palmer | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8635 | Sven Botman | 220237 | Sven Botman | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8666 | Cheick Oumar Doucoure | 438464 | Cheick Doucouré | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2425 | 8706 | Eberechi Eze | 232413 | Eberechi Eze | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8720 | Jack Harrison | 221399 | Jack Harrison | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8780 | Joël Veltman | 111478 | Joël Veltman | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8786 | Stefan Ortega Moreno | 88248 | Stefan Ortega Moreno | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8808 | Wataru Endo | 158983 | Endo Wataru | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8831 | Iyenoma Destiny Udogie | 487053 | Destiny Udogie | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8845 | Hee-Chan Hwang | 184754 | Hwang Hee-chan | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8853 | Maxence Lacroix | 437499 | Maxence Lacroix | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8858 | Guglielmo Vicario | 184254 | Guglielmo Vicario | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8859 | Mikkel Damsgaard | 440089 | Mikkel Damsgaard | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8864 | Matthew Cash | 199796 | Matty Cash | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8865 | Ollie Watkins | 178301 | Ollie Watkins | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8868 | Liam Delap | 463034 | Liam Delap | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8940 | Antonee Robinson | 169528 | Antonee Robinson | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8941 | Jacob Ramsey | 232653 | Jacob Ramsey | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8961 | Rúben Dias | 171314 | Rúben Gato Alves Dias | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 8981 | Jéremy Doku | 248875 | Jérémy Doku | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9017 | Malo Gusto | 482609 | Malo Gusto | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9021 | Pape Sarr | 482442 | Pape Matar Sarr | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9098 | Robert Sánchez | 215059 | Robert Sánchez | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9105 | Radu Dragusin | 493125 | Radu Drăgușin | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9154 | Elliot Anderson | 215379 | Elliot Anderson | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9156 | Kevin Schade | 513418 | Kevin Schade | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9272 | Filip Jorgensen | 508479 | Filip Jørgensen | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9307 | Iliman Ndiaye | 440993 | Iliman Ndiaye | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9332 | Dane Scarlett | 490145 | Dane Scarlett | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9415 | Jaden Philogene-Bidace | 481624 | Jaden Philogene | name-variant | high | 1.06 | team-and-shared-name-tokens |
| 2425 | 9451 | Chimuanya Ugochukwu | 503714 | Lesley Ugochukwu | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9453 | Moisés Caicedo | 486672 | Moisés Caicedo Corozo | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9492 | Crysencio Summerville | 450070 | Crysencio Summerville | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9501 | Fabio Carvalho | 244858 | Fábio Freitas Gouveia Carvalho | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9512 | Valentino Livramento | 441191 | Tino Livramento | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9524 | Anthony Elanga | 449434 | Anthony Elanga | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9554 | Tim Iroegbunam | 490094 | Tim Iroegbunam | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9556 | William Osula | 538207 | William Osula | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9662 | Dango Ouattara | 533463 | Dango Ouattara | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9667 | Amadou Onana | 449871 | Amadou Onana | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9676 | David Raya | 154561 | David Raya Martin | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9677 | Kristoffer Ajer | 191866 | Kristoffer Ajer | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9678 | Ethan Pinnock | 231065 | Ethan Pinnock | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9679 | Rico Henry | 194010 | Rico Henry | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9680 | Vitaly Janelt | 204580 | Vitaly Janelt | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9681 | Frank Onyeka | 428580 | Frank Onyeka | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9685 | Mads Roerslev | 226956 | Mads Roerslev Rasmussen | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2425 | 9733 | Nathan Collins | 432830 | Nathan Collins | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9739 | Kiernan Dewsbury-Hall | 215413 | Kiernan Dewsbury-Hall | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9740 | José Sá | 149065 | José Malheiro de Sá | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9749 | Donyell Malen | 204646 | Donyell Malen | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9780 | Mathys Tel | 511499 | Mathys Tel | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9788 | Dominik Szoboszlai | 424876 | Dominik Szoboszlai | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9790 | Josko Gvardiol | 477424 | Joško Gvardiol | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9802 | Nico González | 465694 | Nico González | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9958 | Yerson Mosquera | 501837 | Yerson Mosquera | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 9983 | Beto | 486385 | Norberto Bercique Gomes Betuncal | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10004 | Romeo Lavia | 514356 | Roméo Lavia | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10025 | Lamare Bogarde | 515597 | Lamare Bogarde | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10036 | Jeremy Sarmiento | 441192 | Jeremy Sarmiento Morante | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2425 | 10050 | Micky van de Ven | 491279 | Micky van de Ven | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10120 | Conor Bradley | 492777 | Conor Bradley | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10126 | James McAtee | 432714 | James McAtee | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10184 | Archie Gray | 547701 | Archie Gray | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10216 | Lewis Hall | 487838 | Lewis Hall | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10291 | Vitalii Mykolenko | 224967 | Vitalii Mykolenko | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10292 | Nathan Patterson | 243571 | Nathan Patterson | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10293 | Toti | 510362 | Toti António Gomes | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10327 | Chiquinho | 510363 | Francisco Jorge Tomás Oliveira | name-variant | high | 1.03 | web-name-exact |
| 2425 | 10348 | Omari Hutchinson | 503301 | Omari Giraud-Hutchinson | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10527 | Carlos Baleba | 535301 | Carlos Baleba | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10552 | Alejandro Garnacho | 493105 | Alejandro Garnacho | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10564 | Leny Yoro | 550864 | Leny Yoro | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10586 | Tyler Dibling | 496661 | Tyler Dibling | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10696 | Noussair Mazraoui | 230001 | Noussair Mazraoui | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10697 | Ryan Gravenberch | 441266 | Ryan Gravenberch | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10717 | Rodrigo Muniz | 244042 | Rodrigo Muniz Carvalho | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10720 | Darwin Núñez | 447203 | Darwin Núñez Ribeiro | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2425 | 10721 | Sepp van den Berg | 444765 | Sepp van den Berg | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10741 | Marcus Tavernier | 201658 | Marcus Tavernier | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10744 | Ryan Christie | 158499 | Ryan Christie | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10747 | James Hill | 463981 | James Hill | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10760 | Brennan Johnson | 242898 | Brennan Johnson | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10764 | Djed Spence | 232859 | Djed Spence | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10766 | Joe Ayodele-Aribo | 193204 | Joe Aribo | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2425 | 10802 | Lisandro Martínez | 221820 | Lisandro Martínez | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10803 | Tyrell Malacia | 222690 | Tyrell Malacia | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10805 | Levi Colwill | 460028 | Levi Colwill | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10806 | Kaoru Mitoma | 451340 | Mitoma Kaoru | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10807 | Jan Paul van Hecke | 469142 | Jan Paul van Hecke | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10809 | Keane Lewis-Potter | 249231 | Keane Lewis-Potter | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10822 | Wilson Odobert | 550839 | Wilson Odobert | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10847 | Rico Lewis | 477064 | Rico Lewis | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10856 | Emmanuel Agbadou | 516939 | Emmanuel Agbadou | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10864 | Marcos Senesi | 221466 | Marcos Senesi | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 10945 | Santiago Bueno | 231480 | Santiago Bueno | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11000 | Matheus Nunes | 465351 | Matheus Luiz Nunes | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11003 | Ryan Yates | 204968 | Ryan Yates | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11070 | Jørgen Strand Larsen | 247412 | Jørgen Strand Larsen | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11094 | Antony | 467169 | Antony Matheus dos Santos | name-variant | high | 1.03 | web-name-exact |
| 2425 | 11132 | Ethan Nwaneri | 499175 | Ethan Nwaneri | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11167 | Chadi Riad | 515621 | Chadi Riad Dnanou | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11174 | Kobbie Mainoo | 516895 | Kobbie Mainoo | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11269 | Jack Hinshelwood | 532529 | Jack Hinshelwood | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11281 | Michael Kayode | 607464 | Michael Kayode | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11296 | Cody Gakpo | 243298 | Cody Gakpo | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11297 | Carlos Alcaraz | 502697 | Carlos Alcaraz Durán | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11310 | Brajan Gruda | 513433 | Brajan Gruda | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11317 | Danilo | 513046 | Danilo dos Santos de Oliveira | name-variant | high | 1.03 | web-name-exact |
| 2425 | 11356 | Enzo Fernández | 448047 | Enzo Fernández | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11357 | Noni Madueke | 248857 | Noni Madueke | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11361 | Daniel Bentley | 79602 | Daniel Bentley | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11362 | Facundo Buonanotte | 536916 | Facundo Buonanotte | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11363 | Antoine Semenyo | 437730 | Antoine Semenyo | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11383 | Renato Veiga | 551230 | Renato Palma Veiga | name-variant | high | 1.03 | web-name-exact |
| 2425 | 11384 | João Gomes | 448089 | João Victor Gomes da Silva | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11385 | Yasin Ayari | 509416 | Yasin Ayari | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11386 | Lewis Miley | 547719 | Lewis Miley | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11592 | Nico O&#039;Reilly | 472769 | Nico O'Reilly | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11633 | Marc Guiu | 499309 | Marc Guiu Paz | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11707 | Jurriën Timber | 445122 | Jurriën Timber | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11709 | Milos Kerkez | 544877 | Milos Kerkez | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11710 | Simon Adingra | 535818 | Simon Adingra | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11711 | Bart Verbruggen | 489639 | Bart Verbruggen | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11728 | Calvin Bassey | 232892 | Calvin Bassey | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11735 | Sávio | 510281 | Sávio 'Savinho' Moreira de Oliveira | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11745 | Julián Araujo | 436893 | Julián Araujo Zúñiga | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2425 | 11763 | Abduqodir Khusanov | 578153 | Abdukodir Khusanov | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11766 | Manuel Ugarte | 232112 | Manuel Ugarte | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11772 | Yehor Yarmolyuk | 508395 | Yehor Yarmoliuk | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11807 | Ian Maatsen | 441302 | Ian Maatsen | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11903 | Oscar Bobb | 477555 | Oscar Bobb | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11926 | Edson Álvarez | 213999 | Edson Álvarez Velázquez | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2425 | 11944 | Patrick Dorgu | 596777 | Patrick Dorgu | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 11984 | Youssef Chermiti | 491012 | Youssef Ramalho Chermiti | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2425 | 12014 | Jake O&#039;Brien | 512462 | Jake O'Brien | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 12027 | Mohammed Kudus | 460842 | Mohammed Kudus | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 12054 | Altay Bayindir | 451302 | Altay Bayindir | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 12123 | Murillo | 575476 | Murillo Santiago Costa dos Santos | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 12149 | Alex Scott | 503139 | Alex Scott | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 12152 | Matheus França | 536694 | Matheus França de Oliveira | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2425 | 12272 | Myles Lewis-Skelly | 499169 | Myles Lewis-Skelly | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 12358 | Oliver Scarles | 536109 | Ollie Scarles | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 12408 | Daniel Muñoz | 247348 | Daniel Muñoz | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 12409 | Adam Wharton | 496221 | Adam Wharton | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 12410 | Joshua King | 577725 | Josh King | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 12412 | Morgan Rogers | 244850 | Morgan Rogers | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 12535 | Josh Acheampong | 577016 | Josh Acheampong | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 12573 | Tyrique George | 550615 | Tyrique George | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 12595 | Hákon Valdimarsson | 507433 | Hákon Valdimarsson | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 12633 | Yunus Konak | 628204 | Yunus Emre Konak | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2425 | 12752 | Sammie Szmodics | 172453 | Sam Szmodics | name-variant | high | 1.045 | team-and-shared-name-tokens |
| 2425 | 12753 | Marcus Harness | 167191 | Marcus Myers-Harness | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2425 | 12756 | Rodrigo Gomes | 483081 | Rodrigo Martins Gomes | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 12757 | Harrison Armstrong | 609873 | Harrison Armstrong | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 12758 | Mats Wieffer | 467779 | Mats Wieffer | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 12759 | Yankuba Minteh | 592031 | Yankuba Minteh | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 12761 | Yukinari Sugawara | 219279 | Sugawara Yukinari | name-variant | high | 1.03 | unordered-full-name-exact |
| 2425 | 12763 | Nathan Wood | 244845 | Nathan Wood-Gordon | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2425 | 12766 | Jota Silva | 510500 | João Pedro Ferreira Silva | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 12774 | Andy Irving | 229384 | Andy Irving | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 12910 | Mads Hermansen | 467189 | Mads Hermansen | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 12912 | Lucas Bergvall | 570526 | Lucas Bergvall | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 12948 | Mateus Fernandes | 551226 | Mateus Gonçalo Espanha Fernandes | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 12963 | Evanilson | 444102 | Francisco Evanilson de Lima Barbosa | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 13022 | André | 509291 | André Trindade da Costa Neto | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 13026 | Luis Guilherme | 577114 | Luis Guilherme Lira dos Santos | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 13038 | Justin Devenny | 489706 | Justin Devenny | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 13066 | Ferdi Kadioglu | 231416 | Ferdi Kadioglu | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 13068 | Morato | 485047 | Felipe Rodrigues da Silva | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 13080 | Ayden Heaven | 606745 | Ayden Heaven | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 13092 | Carlos Forbs | 463212 | Carlos Roberto Forbs Borges | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2425 | 13156 | Pedro Lima | 641221 | Pedro Cardoso de Lima | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 13206 | Matt O&#039;Riley | 219249 | Matt O'Riley | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 13222 | Thiago | 502500 | Igor Thiago Nascimento Rodrigues | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 13242 | Ben Winterburn | 606775 | Ben Winterburn | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 13348 | Antonín Kinsky | 485055 | Antonín Kinsky | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 13364 | Diego Gómez | 514254 | Diego Gómez | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 13380 | Vitor Reis | 616222 | Vitor de Oliveira Nunes dos Reis | name-variant | high | 1.03 | web-name-exact |
| 2425 | 13387 | Romain Esse | 606921 | Romain Esse | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 13392 | Andrés García | 606798 | Andrés García | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 13403 | Welington | 500016 | Welington Damascena Santos | name-variant | high | 1.03 | web-name-exact |
| 2425 | 13467 | Tyler Fredricson | 547676 | Tyler Fredricson | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 13474 | Julio Soler | 575901 | Julio Soler | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 13476 | Shumaira Mheuka | 567119 | Shumaira Mheuka | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 13484 | Mateus Mané | 647671 | Mateus Mané | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 13584 | Harry Howell | 597320 | Harry Howell | carried-forward | high | 1 | carried-from-2526 |
| 2425 | 13588 | Gustavo Nunes | 626464 | Gustavo Nunes Fernandes Gomes | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2324 | 65 | Timo Werner | 165153 | Timo Werner | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 76 | Fabian Schär | 119471 | Fabian Schär | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 87 | Joelinton | 180974 | Joelinton Cássio Apolinário de Lira | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 181 | Bernd Leno | 80201 | Bernd Leno | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 229 | Thiago Alcántara | 61558 | Thiago Alcántara do Nascimento | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2324 | 239 | Pascal Groß | 60307 | Pascal Groß | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 375 | Odisseas Vlachodimos | 111452 | Odysseas Vlachodimos | name-variant | high | 1.056 | team-and-close-first-name-expanded-last-name |
| 2324 | 447 | Kevin De Bruyne | 61366 | Kevin De Bruyne | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 453 | Son Heung-Min | 85971 | Son Heung-min | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 468 | Callum Wilson | 75115 | Callum Wilson | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 486 | Adam Lallana | 39155 | Adam Lallana | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 488 | Philippe Coutinho | 84583 | Philippe Coutinho Correia | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2324 | 489 | James Milner | 15157 | James Milner | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 500 | Alex Iwobi | 153133 | Alex Iwobi | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 501 | Danny Welbeck | 50175 | Danny Welbeck | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 510 | Joel Ward | 55494 | Joel Ward | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 531 | Michail Antonio | 57531 | Michail Antonio | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 534 | Aaron Cresswell | 55459 | Aaron Cresswell | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 556 | Marcus Rashford | 176297 | Marcus Rashford | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 579 | Nathan Aké | 126184 | Nathan Aké | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 585 | Seamus Coleman | 59949 | Seamus Coleman | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 586 | John Stones | 97299 | John Stones | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 592 | Ross Barkley | 88894 | Ross Barkley | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 603 | Nathaniel Clyne | 57328 | Nathaniel Clyne | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 618 | Raheem Sterling | 103955 | Raheem Sterling | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 631 | Ashley Young | 18892 | Ashley Young | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 638 | Kyle Walker | 58621 | Kyle Walker | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 646 | Christian Eriksen | 80607 | Christian Eriksen | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 652 | Kieran Trippier | 77794 | Kieran Trippier | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 660 | Ben Davies | 115556 | Ben Davies | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 668 | Idrissa Gueye | 80801 | Idrissa Gueye | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 672 | Jordan Ayew | 80146 | Jordan Ayew | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 675 | Jack Grealish | 114283 | Jack Grealish | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 695 | Bertrand Traoré | 110504 | Bertrand Traoré | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 700 | Willian | 47431 | Willian Borges da Silva | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 706 | Lukasz Fabianski | 37096 | Lukasz Fabianski | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 725 | Ola Aina | 159506 | Olu Aina | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 741 | Jordan Pickford | 111234 | Jordan Pickford | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 757 | Jeffrey Schlupp | 86417 | Jeffrey Schlupp | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 766 | Jamaal Lascelles | 101148 | Jamaal Lascelles | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 782 | Ben Chilwell | 172850 | Ben Chilwell | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 804 | Craig Dawson | 60232 | Craig Dawson | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 807 | Jonny Evans | 37642 | Jonny Evans | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 825 | Adam Smith | 54469 | Adam Smith | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 833 | Virgil van Dijk | 97032 | Virgil van Dijk | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 843 | James Ward-Prowse | 101178 | James Ward-Prowse | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 847 | Cédric Soares | 58822 | Cédric Alves Soares | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2324 | 884 | Matt Targett | 169359 | Matt Targett | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 900 | Adama Traoré | 159533 | Adama Traoré | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 910 | Harrison Reed | 153366 | Harrison Reed | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 922 | Andreas Pereira | 156689 | Andreas Hoelgebaum Pereira | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 978 | Sam Johnstone | 101982 | Sam Johnstone | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 985 | Mason Holgate | 194164 | Mason Holgate | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 986 | Danny Ings | 84939 | Danny Ings | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 987 | Joseph Gomez | 171287 | Joe Gomez | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 1006 | Luke Shaw | 106760 | Luke Shaw | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 1018 | Josh Cullen | 172567 | Josh Cullen | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 1024 | Tyrone Mings | 149484 | Tyrone Mings | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 1228 | Bruno Fernandes | 141746 | Bruno Borges Fernandes | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 1245 | Emerson | 109533 | Emerson Palmieri dos Santos | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 1250 | Mohamed Salah | 118748 | Mohamed Salah | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 1257 | Alisson | 116535 | Alisson Ramses Becker | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 1297 | Neto | 69752 | Norberto Murara Neto | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 1299 | Mario Lemina | 151086 | Mario Lemina | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 1389 | Jorginho | 85955 | Jorge Luiz Frello Filho | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 1537 | Sasa Lukic | 212314 | Saša Lukić | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 1545 | Emil Krafth | 111773 | Emil Krafth | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 1653 | Michael Keane | 106611 | Michael Keane | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 1654 | Ben Mee | 51927 | Ben Mee | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 1665 | James Tarkowski | 17761 | James Tarkowski | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 1679 | Dominic Solanke | 154566 | Dominic Solanke | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 1687 | Harry Maguire | 95658 | Harry Maguire | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 1688 | Andrew Robertson | 122798 | Andrew Robertson | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 1726 | Abdoulaye Doucouré | 121599 | Abdoulaye Doucouré | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 1776 | Jarrod Bowen | 178186 | Jarrod Bowen | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 1789 | Lewis Cook | 155408 | Lewis Cook | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 1791 | Trent Alexander-Arnold | 169187 | Trent Alexander-Arnold | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 1823 | Lucas Digne | 101188 | Lucas Digne | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 2182 | Jefferson Lerma | 152551 | Jefferson Lerma Solís | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 2199 | Pablo Sarabia | 88484 | Pablo Sarabia | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 2248 | Casemiro | 61256 | Carlos Henrique Casimiro | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 2254 | Mateo Kovacic | 91651 | Mateo Kovačić | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 2280 | Jonny | 114128 | Jonathan Castro Otto | name-variant | high | 1.04 | team-and-first-name-season-stats-supported |
| 2324 | 2310 | Alphonse Areola | 84182 | Alphonse Areola | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 2328 | Thomas Partey | 167199 | Thomas Partey | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 2335 | Pablo Fornals | 217593 | Pablo Fornals Malla | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2324 | 2383 | André Gomes | 120250 | André Tavares Gomes | name-variant | high | 1.03 | web-name-exact |
| 2324 | 2496 | Rodri | 220566 | Rodrigo Hernandez | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 2517 | Martin Odegaard | 184029 | Martin Ødegaard | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 2958 | Oleksandr Zinchenko | 206325 | Oleksandr Zinchenko | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 3203 | Issa Diop | 219924 | Issa Diop | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 3278 | Maxwel Cornet | 149519 | Maxwel Cornet | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 3288 | Thiago Silva | 51090 | Thiago Emiliano da Silva | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2324 | 3300 | Christopher Nkunku | 213198 | Christopher Nkunku | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 3635 | Bernardo Silva | 165809 | Bernardo Veiga de Carvalho e Silva | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 3697 | Odsonne Edouard | 199670 | Odsonne Edouard | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 4105 | Raúl Jiménez | 102057 | Raúl Jiménez | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 4120 | Álex Moreno | 106468 | Alexandre Moreno Lopera | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 4401 | Emiliano Martinez | 98980 | Emiliano Martínez Romero | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 4456 | Chris Wood | 60689 | Chris Wood | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 5136 | Estupiñán | 204214 | Pervis Estupiñán | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 5220 | Kai Havertz | 219847 | Kai Havertz | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 5221 | Leon Bailey | 215711 | Leon Bailey | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 5232 | Alexander Isak | 219168 | Alexander Isak | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 5355 | Jacob Bruun Larsen | 179458 | Jacob Bruun Larsen | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 5543 | Gabriel Jesus | 205651 | Gabriel Fernando de Jesus | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 5552 | Nick Pope | 98747 | Nick Pope | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 5553 | Declan Rice | 204480 | Declan Rice | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 5555 | Dominic Calvert-Lewin | 177815 | Dominic Calvert-Lewin | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 5560 | Scott McTominay | 195851 | Scott McTominay | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 5584 | Aaron Wan-Bissaka | 214590 | Aaron Wan-Bissaka | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 5590 | Tosin Adarabioyo | 109646 | Tosin Adarabioyo | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 5596 | Harry Wilson | 153682 | Harry Wilson | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 5603 | Aaron Ramsdale | 225321 | Aaron Ramsdale | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 5609 | Yves Bissouma | 227127 | Yves Bissouma | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 5613 | Gabriel | 226597 | Gabriel dos Santos Magalhães | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 5712 | Diego Carlos | 165659 | Diego Carlos Santos Silva | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 5722 | Ibrahim Sangare | 210462 | Ibrahim Sangaré | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 5735 | Jean-Philippe Mateta | 231747 | Jean-Philippe Mateta | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 5786 | Yoane Wissa | 216646 | Yoane Wissa | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 5789 | Boubacar Kamara | 226944 | Boubacar Kamara | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 5803 | Fode Toure | 225897 | Fodé Ballo-Touré | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2324 | 5956 | Youri Tielemans | 166989 | Youri Tielemans | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 5973 | Kenny Tete | 167074 | Kenny Tete | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6026 | Richarlison | 212319 | Richarlison de Andrade | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6030 | Zanka | 48760 | Mathias Jorgensen | name-variant | high | 1.03 | web-name-exact |
| 2324 | 6034 | Philip Billing | 168991 | Philip Billing | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 6044 | Charlie Taylor | 103914 | Charlie Taylor | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 6048 | Lewis Dunk | 83299 | Lewis Dunk | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6049 | Solly March | 109345 | Solly March | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6054 | Ederson | 121160 | Ederson Santana de Moraes | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 6055 | Phil Foden | 209244 | Phil Foden | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6063 | Jacob Murphy | 114243 | Jacob Murphy | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6080 | Victor Lindelöf | 184667 | Victor Lindelöf | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6088 | Orel Mangala | 179519 | Orel Mangala | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 6104 | Will Hughes | 108413 | Will Hughes | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6108 | Rodrigo Bentancur | 202993 | Rodrigo Bentancur | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6122 | Douglas Luiz | 230046 | Douglas Luiz Soares de Paulo | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6157 | Timothy Castagne | 166477 | Timothy Castagne | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6163 | Nélson Semedo | 200402 | Nélson Cabral Semedo | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 6219 | Enes Ünal | 168636 | Enes Ünal | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6221 | Pau Torres | 244954 | Pau Torres | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6314 | Joachim Andersen | 174874 | Joachim Andersen | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6326 | Ibrahima Konaté | 204716 | Ibrahima Konaté | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6345 | Jadon Sancho | 209243 | Jadon Sancho | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6382 | Pedro Neto | 247632 | Pedro Lomba Neto | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6424 | Ben Johnson | 222018 | Ben Johnson | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 6456 | Callum Hudson-Odoi | 209046 | Callum Hudson-Odoi | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6482 | Eddie Nketiah | 205533 | Eddie Nketiah | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6490 | Manuel Akanji | 211975 | Manuel Akanji | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 6492 | Reiss Nelson | 200641 | Reiss Nelson | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6532 | Martin Dubravka | 67089 | Martin Dubravka | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6552 | Bryan Mbeumo | 446008 | Bryan Mbeumo | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6557 | Louis Beyer | 241231 | Jordan Beyer | name-variant | high | 1.035 | team-and-shared-name-tokens |
| 2324 | 6615 | Trevoh Chalobah | 180736 | Trevoh Chalobah | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6630 | Joe Willock | 200089 | Joe Willock | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6665 | Curtis Jones | 206915 | Curtis Jones | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6674 | Rayan Ait Nouri | 448514 | Rayan Aït-Nouri | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6681 | Harvey Barnes | 201666 | Harvey Barnes | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6691 | Dejan Kulusevski | 445044 | Dejan Kulusevski | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 6722 | Konstantinos Mavropanos | 233963 | Konstantinos Mavropanos | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6756 | Dwight McNeil | 433154 | Dwight McNeil | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6818 | James Maddison | 172780 | James Maddison | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6820 | David Brooks | 111317 | David Brooks | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6827 | Bobby Reid | 96994 | Bobby De Cordova-Reid | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 6835 | Tom Cairney | 76357 | Tom Cairney | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6850 | Willy Boly | 90585 | Willy Boly | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 6852 | Matt Doherty | 87835 | Matt Doherty | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6854 | Diogo Jota | 194634 | Diogo Teixeira da Silva | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 6857 | Morgan Gibbs-White | 222531 | Morgan Gibbs-White | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6885 | Axel Disasi | 220362 | Axel Disasi | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6888 | William Saliba | 462424 | William Saliba | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6903 | Matz Sels | 85633 | Matz Sels | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6912 | Pedro Porro | 441164 | Pedro Porro | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6935 | Naif Aguerd | 210494 | Nayef Aguerd | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6962 | Robin Olsen | 111782 | Robin Olsen | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 6963 | Justin Kluivert | 222683 | Justin Kluivert | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 6986 | Hamed Junior Traore | 424044 | Hamed Traorè | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7027 | Arijanet Muric | 232917 | Arijanet Muric | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 7047 | Mark Flekken | 118342 | Mark Flekken | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 7078 | Sean Longstaff | 180135 | Sean Longstaff | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7080 | Matheus Cunha | 430871 | Matheus Santos Carneiro Da Cunha | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7083 | Christian Nørgaard | 128295 | Christian Nørgaard | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7134 | Marc Cucurella | 179268 | Marc Cucurella Saseta | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7166 | Mathias Jensen | 207283 | Mathias Jensen | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7187 | Sergio Reguilón | 199249 | Sergio Reguilón | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 7198 | Oliver Skipp | 209042 | Oliver Skipp | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 7218 | Cristian Romero | 221632 | Cristian Romero | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7230 | Emile Smith-Rowe | 209289 | Emile Smith Rowe | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7235 | Jason Steele | 49262 | Jason Steele | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 7240 | Benoit Badiashile Mukinayi | 242880 | Benoît Badiashile | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7277 | Ryan John Giles | 232351 | Ryan Giles | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2324 | 7281 | Diogo Dalot | 216051 | Diogo Dalot Teixeira | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7298 | Ben White | 198869 | Benjamin White | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7322 | Bukayo Saka | 223340 | Bukayo Saka | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7332 | Max Kilman | 214048 | Max Kilman | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7352 | Tyler Adams | 200785 | Tyler Adams | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7365 | Lucas Paquetá | 224024 | Lucas Tolentino Coelho de Lima | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7382 | Dan Burn | 78916 | Dan Burn | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7395 | Carlos Vinicius | 245824 | Carlos Vinícius Alves Morais | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 7420 | Miguel Almirón | 179018 | Miguel Almirón Rejala | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 7430 | Emerson | 241157 | Emerson Leite de Souza Junior | name-variant | high | 1.06 | team-and-shared-name-tokens |
| 2324 | 7438 | James Garner | 232928 | James Garner | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7498 | Lyle Foster | 435973 | Lyle Foster | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7546 | Harvey Elliott | 444884 | Harvey Elliott | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7582 | Mark Travers | 229600 | Mark Travers | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 7603 | Marc Guehi | 209036 | Marc Guéhi | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7688 | Max Aarons | 232980 | Max Aarons | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 7689 | Ben Godfrey | 198826 | Ben Godfrey | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 7698 | Leandro Trossard | 116216 | Leandro Trossard | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7699 | Adam Webster | 110735 | Adam Webster | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 7702 | Dean Henderson | 172649 | Dean Henderson | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7723 | John McGinn | 122806 | John McGinn | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7726 | Ezri Konsa Ngoyo | 199798 | Ezri Konsa Ngoyo | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7752 | Gabriel Martinelli | 444145 | Gabriel Martinelli Silva | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7762 | Jean-Ricner Bellegarde | 231057 | Jean-Ricner Bellegarde | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7768 | Mason Mount | 184341 | Mason Mount | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7814 | Taiwo Awoniyi | 210156 | Taiwo Awoniyi | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7904 | Caoimhin Kelleher | 200720 | Caoimhin Kelleher | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7921 | Felipe | 116404 | Felipe Augusto de Almeida Monteiro | name-variant | high | 1.03 | web-name-exact |
| 2324 | 7931 | Takehiro Tomiyasu | 223723 | Takehiro Tomiyasu | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 7943 | Igor Julio | 223434 | Igor Julio dos Santos de Paulo | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7958 | Sandro Tonali | 432422 | Sandro Tonali | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 7967 | Anssumane Fati | 465607 | Anssumane Fati Vieira | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2324 | 7988 | Billy Gilmour | 243568 | Billy Gilmour | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 8067 | Reece James | 225796 | Reece James | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8090 | Lloyd Kelly | 235530 | Lloyd Kelly | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 8119 | Boubacar Traore | 476502 | Boubacar Traoré | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 8127 | Amad Diallo Traore | 493250 | Amad Diallo | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8150 | Anthony Gordon | 232826 | Anthony Gordon | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8204 | Neco Williams | 215136 | Neco Williams | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8214 | Tyrick Mitchell | 244723 | Tyrick Mitchell | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8226 | Tariq Lamptey | 232792 | Tariq Lamptey | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 8252 | Nicolás Domínguez | 250199 | Nicolás Domínguez | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8260 | Erling Haaland | 223094 | Erling Haaland | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8272 | João Pedro | 475168 | João Pedro Junqueira de Jesus | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8285 | Sander Berge | 207189 | Sander Berge | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8288 | Tomas Soucek | 215439 | Tomáš Souček | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8327 | Bruno Guimarães | 208706 | Bruno Guimarães Rodriguez Moura | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8379 | Alexis Mac Allister | 243016 | Alexis Mac Allister | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8384 | Armando Broja | 440323 | Armando Broja | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8430 | Chris Richards | 427623 | Chris Richards | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8476 | Jarrad Branthwaite | 480455 | Jarrad Branthwaite | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8496 | Tommy Doyle | 220394 | Tommy Doyle | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 8497 | Cole Palmer | 244851 | Cole Palmer | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8562 | Luke Thomas | 244619 | Luke Thomas | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 8635 | Sven Botman | 220237 | Sven Botman | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8666 | Cheick Oumar Doucoure | 438464 | Cheick Doucouré | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 8706 | Eberechi Eze | 232413 | Eberechi Eze | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8719 | Kalvin Phillips | 155405 | Kalvin Phillips | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 8720 | Jack Harrison | 221399 | Jack Harrison | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8756 | Dara O&#039;Shea | 216616 | Dara O'Shea | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 8780 | Joël Veltman | 111478 | Joël Veltman | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8786 | Stefan Ortega Moreno | 88248 | Stefan Ortega Moreno | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8808 | Wataru Endo | 158983 | Wataru Endo | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8812 | Sasa Kalajdzic | 429414 | Sasa Kalajdzic | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8831 | Iyenoma Destiny Udogie | 487053 | Destiny Udogie | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8845 | Hee-Chan Hwang | 184754 | Hwang Hee-chan | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8852 | Konstantinos Tsimikas | 214285 | Konstantinos Tsimikas | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 8858 | Guglielmo Vicario | 184254 | Guglielmo Vicario | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8859 | Mikkel Damsgaard | 440089 | Mikkel Damsgaard | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8864 | Matthew Cash | 199796 | Matty Cash | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8865 | Ollie Watkins | 178301 | Ollie Watkins | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8940 | Antonee Robinson | 169528 | Antonee Robinson | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8941 | Jacob Ramsey | 232653 | Jacob Ramsey | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8942 | Aaron Hickey | 472713 | Aaron Hickey | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8961 | Rúben Dias | 171314 | Rúben Gato Alves Dias | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 8965 | Vladimir Coufal | 164555 | Vladimír Coufal | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 8981 | Jéremy Doku | 248875 | Jérémy Doku | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9017 | Malo Gusto | 482609 | Malo Gusto | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9021 | Pape Sarr | 482442 | Pape Matar Sarr | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9040 | Conor Gallagher | 232787 | Conor Gallagher | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9077 | James Trafford | 432720 | James Trafford | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9098 | Robert Sánchez | 215059 | Robert Sánchez | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9105 | Radu Dragusin | 493125 | Radu Dragusin | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9154 | Elliot Anderson | 215379 | Elliot Anderson | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9156 | Kevin Schade | 513418 | Kevin Schade | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9205 | Jayden Bogle | 226182 | Jayden Bogle | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9284 | Jakub Moder | 243505 | Jakub Moder | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 9324 | Facundo Pellistri | 488404 | Facundo Pellistri Rebollo | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2324 | 9332 | Dane Scarlett | 490145 | Dane Scarlett | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9409 | Kaine Hayden | 465390 | Kaine Kesler-Hayden | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2324 | 9415 | Jaden Philogene-Bidace | 481624 | Jaden Philogene-Bidace | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 9451 | Chimuanya Ugochukwu | 503714 | Lesley Ugochukwu | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9453 | Moisés Caicedo | 486672 | Moisés Caicedo Corozo | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9487 | Maxime Estève | 477717 | Maxime Esteve | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9509 | Daniel Jebbison | 523700 | Daniel Jebbison | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 9512 | Valentino Livramento | 441191 | Tino Livramento | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9524 | Anthony Elanga | 449434 | Anthony Elanga | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9554 | Tim Iroegbunam | 490094 | Tim Iroegbunam | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9556 | William Osula | 538207 | William Osula | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9558 | Hannibal Mejbri | 465527 | Hannibal Mejbri | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9662 | Dango Ouattara | 533463 | Dango Ouattara | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9667 | Amadou Onana | 449871 | Amadou Onana | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9676 | David Raya | 154561 | David Raya Martin | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9677 | Kristoffer Ajer | 191866 | Kristoffer Ajer | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9678 | Ethan Pinnock | 231065 | Ethan Pinnock | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9679 | Rico Henry | 194010 | Rico Henry | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9680 | Vitaly Janelt | 204580 | Vitaly Janelt | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9681 | Frank Onyeka | 428580 | Frank Onyeka | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9685 | Mads Roerslev | 226956 | Mads Roerslev Rasmussen | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 9691 | Nuno Tavares | 437626 | Nuno Varela Tavares | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2324 | 9733 | Nathan Collins | 432830 | Nathan Collins | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9740 | José Sá | 149065 | José Malheiro de Sá | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9788 | Dominik Szoboszlai | 424876 | Dominik Szoboszlai | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9790 | Josko Gvardiol | 477424 | Joško Gvardiol | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 9912 | Cameron Archer | 433979 | Cameron Archer | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 9983 | Beto | 486385 | Norberto Bercique Gomes Betuncal | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10004 | Romeo Lavia | 514356 | Roméo Lavia | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10012 | Jakub Kiwior | 440854 | Jakub Kiwior | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 10048 | Nicolas Jackson | 517052 | Nicolas Jackson | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 10050 | Micky van de Ven | 491279 | Micky van de Ven | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10120 | Conor Bradley | 492777 | Conor Bradley | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10126 | James McAtee | 432714 | James McAtee | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10140 | Hugo Bueno | 490721 | Hugo Bueno López | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10177 | Evan Ferguson | 487117 | Evan Ferguson | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 10187 | Jarell Quansah | 441428 | Jarell Quansah | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 10205 | Myles Peart-Harris | 450539 | Myles Peart-Harris | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10216 | Lewis Hall | 487838 | Lewis Hall | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10291 | Vitalii Mykolenko | 224967 | Vitalii Mykolenko | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10292 | Nathan Patterson | 243571 | Nathan Patterson | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10293 | Toti | 510362 | Toti António Gomes | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10405 | Josh Dasilva | 183656 | Josh Dasilva | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10408 | Luis Díaz | 244731 | Luis Díaz | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 10527 | Carlos Baleba | 535301 | Carlos Baleba | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10552 | Alejandro Garnacho | 493105 | Alejandro Garnacho | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10697 | Ryan Gravenberch | 441266 | Ryan Gravenberch | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10715 | João Palhinha | 154296 | João Palhinha Gonçalves | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10717 | Rodrigo Muniz | 244042 | Rodrigo Muniz Carvalho | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10720 | Darwin Núñez | 447203 | Darwin Núñez Ribeiro | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 10741 | Marcus Tavernier | 201658 | Marcus Tavernier | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10744 | Ryan Christie | 158499 | Ryan Christie | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10746 | Jaidon Anthony | 444180 | Jaidon Anthony | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10747 | James Hill | 463981 | James Hill | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10756 | Joe Worrall | 208912 | Joe Worrall | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10758 | Harry Toffolo | 114241 | Harry Toffolo | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 10760 | Brennan Johnson | 242898 | Brennan Johnson | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10802 | Lisandro Martínez | 221820 | Lisandro Martínez | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10805 | Levi Colwill | 460028 | Levi Colwill | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10806 | Kaoru Mitoma | 451340 | Kaoru Mitoma | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10807 | Jan Paul van Hecke | 469142 | Jan Paul van Hecke | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10809 | Keane Lewis-Potter | 249231 | Keane Lewis-Potter | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10822 | Wilson Odobert | 550839 | Wilson Odobert | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10847 | Rico Lewis | 477064 | Rico Lewis | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10864 | Marcos Senesi | 221466 | Marcos Senesi | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 10866 | Luis Sinisterra | 224995 | Luis Sinisterra | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 10872 | Vinicius Souza | 424001 | Vini de Souza Costa | name-variant | high | 1.04 | team-and-first-name-season-stats-supported |
| 2324 | 10913 | André Onana | 202641 | André Onana | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 10945 | Santiago Bueno | 231480 | Santiago Bueno | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11000 | Matheus Nunes | 465351 | Matheus Luiz Nunes | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11003 | Ryan Yates | 204968 | Ryan Yates | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11007 | Fábio Vieira | 438098 | Fábio Ferreira Vieira | name-variant | high | 1.03 | web-name-exact |
| 2324 | 11055 | Rasmus Højlund | 497894 | Rasmus Højlund | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 11058 | Julio Enciso | 474120 | Julio Enciso | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 11094 | Antony | 467169 | Antony Matheus dos Santos | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 11132 | Ethan Nwaneri | 499175 | Ethan Nwaneri | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11174 | Kobbie Mainoo | 516895 | Kobbie Mainoo | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11231 | Ben Doak | 496208 | Ben Doak | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11242 | Divin Mubama | 487837 | Divin Mubama | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 11269 | Jack Hinshelwood | 532529 | Jack Hinshelwood | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11296 | Cody Gakpo | 243298 | Cody Gakpo | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11305 | Mykhailo Mudryk | 465920 | Mykhailo Mudryk | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 11317 | Danilo | 513046 | Danilo dos Santos de Oliveira | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 11356 | Enzo Fernández | 448047 | Enzo Fernández | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11357 | Noni Madueke | 248857 | Noni Madueke | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11361 | Daniel Bentley | 79602 | Daniel Bentley | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11362 | Facundo Buonanotte | 536916 | Facundo Buonanotte | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11363 | Antoine Semenyo | 437730 | Antoine Semenyo | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11366 | Jhon Durán | 476344 | Jhon Durán | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 11384 | João Gomes | 448089 | João Victor Gomes da Silva | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11386 | Lewis Miley | 547719 | Lewis Miley | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11409 | Kaelan Casey | 518438 | Kaelan Casey | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 11486 | Illia Zabarnyi | 477580 | Illia Zabarnyi | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 11700 | Vitinho | 441455 | Victor da Silva | name-variant | high | 1.03 | web-name-exact |
| 2324 | 11701 | Zeki Amdouni | 492831 | Zeki Amdouni | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11702 | Benson Manuel | 183751 | Manuel Benson Hedilazio | name-variant | high | 1.035 | team-and-shared-name-tokens |
| 2324 | 11704 | Hjalmar Ekdal | 478969 | Hjalmar Ekdal | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11707 | Jurriën Timber | 445122 | Jurriën Timber | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11709 | Milos Kerkez | 544877 | Milos Kerkez | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11710 | Simon Adingra | 535818 | Simon Adingra | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11711 | Bart Verbruggen | 489639 | Bart Verbruggen | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11715 | Mads Andersen | 208904 | Mads Juel Andersen | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2324 | 11719 | Chiedozie Ogbene | 229164 | Chiedozie Ogbene | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 11728 | Calvin Bassey | 232892 | Calvin Bassey | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11730 | Anis Ben Slimane | 504198 | Anis Slimane | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2324 | 11772 | Yehor Yarmolyuk | 508395 | Yegor Yarmoliuk | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11807 | Ian Maatsen | 441302 | Ian Maatsen | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11808 | Andrey Santos | 532605 | Andrey Nascimento dos Santos | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11815 | Ben Brereton Díaz | 204814 | Ben Brereton | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 11903 | Oscar Bobb | 477555 | Oscar Bobb | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 11926 | Edson Álvarez | 213999 | Edson Álvarez Velázquez | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 11984 | Youssef Chermiti | 491012 | Youssef Ramalho Chermiti | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 12027 | Mohammed Kudus | 460842 | Mohammed Kudus | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 12032 | Djordje Petrovic | 457569 | Đorđe Petrović | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 12033 | Deivid Washington | 617054 | Deivid Washington de Souza Eugênio | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2324 | 12034 | Brandon Aguilera | 461682 | Brandon Aguilera Zamora | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2324 | 12094 | Mike Trésor | 437748 | Mike Trésor | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 12123 | Murillo | 575476 | Murillo Santiago Costa dos Santos | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 12149 | Alex Scott | 503139 | Alex Scott | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 12152 | Matheus França | 536694 | Matheus França de Oliveira | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 12199 | Alex Murphy | 545477 | Alex Murphy | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 12234 | Tawanda Chirewa | 497606 | Tawanda Chirewa | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 12408 | Daniel Muñoz | 247348 | Daniel Muñoz | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 12409 | Adam Wharton | 496221 | Adam Wharton | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 12412 | Morgan Rogers | 244850 | Morgan Rogers | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 12418 | Rodrigo Ribeiro | 551232 | Rodrigo Duarte Ribeiro | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2324 | 12455 | Jayden Danns | 500058 | Jayden Danns | carried-forward | high | 1 | carried-from-2425 |
| 2324 | 12474 | George Earthy | 490885 | George Earthy | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 12535 | Josh Acheampong | 577016 | Josh Acheampong | carried-forward | high | 1 | carried-from-2526 |
| 2324 | 12603 | Mikey Moore | 499721 | Mikey Moore | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 76 | Fabian Schär | 119471 | Fabian Schär | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 87 | Joelinton | 180974 | Joelinton Cássio Apolinário de Lira | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 181 | Bernd Leno | 80201 | Bernd Leno | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 204 | Granit Xhaka | 84450 | Granit Xhaka | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 229 | Thiago Alcántara | 61558 | Thiago Alcántara do Nascimento | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 239 | Pascal Groß | 60307 | Pascal Groß | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 314 | Ilkay Gündogan | 59859 | Ilkay Gündogan | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 332 | Joel Matip | 60914 | Joel Matip | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 343 | Pierre-Emile Højbjerg | 132015 | Pierre-Emile Højbjerg | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 447 | Kevin De Bruyne | 61366 | Kevin De Bruyne | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 448 | Ivan Perisic | 45034 | Ivan Perišić | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 453 | Son Heung-Min | 85971 | Son Heung-min | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 461 | Matt Ritchie | 56983 | Matt Ritchie | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 468 | Callum Wilson | 75115 | Callum Wilson | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 473 | Danny Ward | 95463 | Danny Ward | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 486 | Adam Lallana | 39155 | Adam Lallana | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 488 | Philippe Coutinho | 84583 | Philippe Coutinho Correia | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 489 | James Milner | 15157 | James Milner | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 496 | Mohamed Elneny | 153256 | Mohamed Elneny | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 500 | Alex Iwobi | 153133 | Alex Iwobi | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 501 | Danny Welbeck | 50175 | Danny Welbeck | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 508 | Calum Chambers | 101184 | Calum Chambers | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 510 | Joel Ward | 55494 | Joel Ward | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 528 | Angelo Ogbonna | 40669 | Angelo Ogbonna | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 530 | James Tomkins | 49413 | James Tomkins | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 531 | Michail Antonio | 57531 | Michail Antonio | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 532 | Cheikhou Kouyaté | 55037 | Cheikhou Kouyaté | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 534 | Aaron Cresswell | 55459 | Aaron Cresswell | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 546 | David de Gea | 51940 | David De Gea Quintana | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2223 | 553 | Anthony Martial | 148225 | Anthony Martial | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 556 | Marcus Rashford | 176297 | Marcus Rashford | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 561 | Joe Rothwell | 156685 | Joe Rothwell | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 579 | Nathan Aké | 126184 | Nathan Aké | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 585 | Seamus Coleman | 59949 | Seamus Coleman | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 586 | John Stones | 97299 | John Stones | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 603 | Nathaniel Clyne | 57328 | Nathaniel Clyne | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 605 | Jordan Henderson | 56979 | Jordan Henderson | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 618 | Raheem Sterling | 103955 | Raheem Sterling | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 631 | Ashley Young | 18892 | Ashley Young | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 635 | Alex McCarthy | 58376 | Alex McCarthy | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 638 | Kyle Walker | 58621 | Kyle Walker | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 643 | Eric Dier | 93264 | Eric Dier | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 646 | Christian Eriksen | 80607 | Christian Eriksen | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 652 | Kieran Trippier | 77794 | Kieran Trippier | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 660 | Ben Davies | 115556 | Ben Davies | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 668 | Idrissa Gueye | 80801 | Idrissa Gueye | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 672 | Jordan Ayew | 80146 | Jordan Ayew | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 675 | Jack Grealish | 114283 | Jack Grealish | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 695 | Bertrand Traoré | 110504 | Bertrand Traoré | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 700 | Willian | 47431 | Willian Borges da Silva | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 706 | Lukasz Fabianski | 37096 | Lukasz Fabianski | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 741 | Jordan Pickford | 111234 | Jordan Pickford | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 755 | Jamie Vardy | 101668 | Jamie Vardy | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 757 | Jeffrey Schlupp | 86417 | Jeffrey Schlupp | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 766 | Jamaal Lascelles | 101148 | Jamaal Lascelles | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 773 | Aleksandar Mitrovic | 128389 | Aleksandar Mitrović | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 782 | Ben Chilwell | 172850 | Ben Chilwell | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 790 | Nathan Redmond | 83283 | Nathan Redmond | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 802 | Diego Costa | 18507 | Diego Da Silva Costa | name-variant | high | 1.03 | web-name-exact |
| 2223 | 804 | Craig Dawson | 60232 | Craig Dawson | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 807 | Jonny Evans | 37642 | Jonny Evans | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 825 | Adam Smith | 54469 | Adam Smith | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 831 | Fraser Forster | 40383 | Fraser Forster | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 833 | Virgil van Dijk | 97032 | Virgil van Dijk | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 842 | Oriol Romeu | 78056 | Oriol Romeu Vidal | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2223 | 843 | James Ward-Prowse | 101178 | James Ward-Prowse | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 847 | Cédric Soares | 58822 | Cédric Alves Soares | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 884 | Matt Targett | 169359 | Matt Targett | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 885 | Kyle Walker-Peters | 158534 | Kyle Walker-Peters | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 900 | Adama Traoré | 159533 | Adama Traoré Diarra | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 910 | Harrison Reed | 153366 | Harrison Reed | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 922 | Andreas Pereira | 156689 | Andreas Hoelgebaum Pereira | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 935 | Kurt Zouma | 103192 | Kurt Zouma | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 978 | Sam Johnstone | 101982 | Sam Johnstone | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 985 | Mason Holgate | 194164 | Mason Holgate | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 986 | Danny Ings | 84939 | Danny Ings | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 987 | Joseph Gomez | 171287 | Joseph Gomez | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 998 | Ivan Toney | 144485 | Ivan Toney | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 1006 | Luke Shaw | 106760 | Luke Shaw | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 1024 | Tyrone Mings | 149484 | Tyrone Mings | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 1042 | Tom Davies | 173807 | Tom Davies | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 1078 | Sergi Canos | 174932 | Sergi Canós Tenés | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2223 | 1228 | Bruno Fernandes | 141746 | Bruno Borges Fernandes | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 1245 | Emerson | 109533 | Emerson Palmieri dos Santos | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 1250 | Mohamed Salah | 118748 | Mohamed Salah | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 1257 | Alisson | 116535 | Alisson Ramses Becker | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 1297 | Neto | 69752 | Norberto Murara Neto | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 1299 | Mario Lemina | 151086 | Mario Lemina | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 1389 | Jorginho | 85955 | Jorge Luiz Frello Filho | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 1537 | Sasa Lukic | 212314 | Sasa Lukic | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 1545 | Emil Krafth | 111773 | Emil Krafth | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 1653 | Michael Keane | 106611 | Michael Keane | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 1654 | Ben Mee | 51927 | Ben Mee | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 1665 | James Tarkowski | 17761 | James Tarkowski | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 1679 | Dominic Solanke | 154566 | Dominic Solanke | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 1683 | Ryan Fraser | 90105 | Ryan Fraser | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 1687 | Harry Maguire | 95658 | Harry Maguire | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 1688 | Andrew Robertson | 122798 | Andrew Robertson | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 1719 | Javier Manquillo | 109528 | Javier Manquillo Gaitán | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2223 | 1726 | Abdoulaye Doucouré | 121599 | Abdoulaye Doucouré | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 1735 | Jack Stephens | 88900 | Jack Stephens | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 1776 | Jarrod Bowen | 178186 | Jarrod Bowen | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 1789 | Lewis Cook | 155408 | Lewis Cook | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 1791 | Trent Alexander-Arnold | 169187 | Trent Alexander-Arnold | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 1823 | Lucas Digne | 101188 | Lucas Digne | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 2182 | Jefferson Lerma | 152551 | Jefferson Lerma Solís | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 2199 | Pablo Sarabia | 88484 | Pablo Sarabia | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 2203 | Emiliano Buendía | 195546 | Emiliano Buendía Stati | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 2245 | Raphael Varane | 90152 | Raphaël Varane | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 2248 | Casemiro | 61256 | Carlos Henrique Casimiro | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 2254 | Mateo Kovacic | 91651 | Mateo Kovacic | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 2280 | Jonny | 114128 | Jonathan Castro Otto | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 2310 | Alphonse Areola | 84182 | Alphonse Areola | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 2328 | Thomas Partey | 167199 | Thomas Partey | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 2335 | Pablo Fornals | 217593 | Pablo Fornals Malla | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 2371 | Cristiano Ronaldo | 14937 | Cristiano Ronaldo dos Santos Aveiro | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2223 | 2381 | Rodrigo | 80954 | Rodrigo Moreno | name-variant | high | 1.03 | web-name-exact |
| 2223 | 2496 | Rodri | 220566 | Rodrigo Hernandez | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 2498 | Aymeric Laporte | 146941 | Aymeric Laporte | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 2517 | Martin Odegaard | 184029 | Martin Ødegaard | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 2674 | Thilo Kehrer | 201057 | Thilo Kehrer | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 2958 | Oleksandr Zinchenko | 206325 | Oleksandr Zinchenko | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 3203 | Issa Diop | 219924 | Issa Diop | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 3278 | Maxwel Cornet | 149519 | Maxwel Cornet | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 3288 | Thiago Silva | 51090 | Thiago Emiliano da Silva | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 3293 | Lucas Moura | 95715 | Lucas Rodrigues Moura da Silva | name-variant | high | 1.03 | web-name-exact |
| 2223 | 3303 | Ricardo Pereira | 111931 | Ricardo Barbosa Pereira | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 3420 | Fabinho | 116643 | Fabio Henrique Tavares | name-variant | high | 1.03 | web-name-exact |
| 2223 | 3422 | João Moutinho | 19624 | João Filipe Iria Santos Moutinho | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2223 | 3585 | Said Benrahma | 172841 | Saïd Benrahma | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 3600 | Serge Aurier | 80226 | Serge Aurier | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 3621 | Neal Maupay | 115382 | Neal Maupay | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 3635 | Bernardo Silva | 165809 | Bernardo Veiga de Carvalho e Silva | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 3697 | Odsonne Edouard | 199670 | Odsonne Edouard | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 4105 | Raúl Jiménez | 102057 | Raúl Jiménez | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 4120 | Álex Moreno | 106468 | Alexandre Moreno Lopera | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 4401 | Emiliano Martinez | 98980 | Emiliano Martínez Romero | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 4419 | Adam Armstrong | 155511 | Adam Armstrong | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 4456 | Chris Wood | 60689 | Chris Wood | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 5050 | Clement Lenglet | 171101 | Clément Lenglet | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 5061 | Kepa | 109745 | Kepa Arrizabalaga | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 5086 | Marc Roca | 234370 | Marc Roca Junqué | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2223 | 5136 | Estupiñán | 204214 | Pervis Estupiñán | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 5220 | Kai Havertz | 219847 | Kai Havertz | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 5221 | Leon Bailey | 215711 | Leon Bailey | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 5232 | Alexander Isak | 219168 | Alexander Isak | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 5543 | Gabriel Jesus | 205651 | Gabriel Fernando de Jesus | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 5545 | Wilfred Ndidi | 203341 | Wilfred Ndidi | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 5552 | Nick Pope | 98747 | Nick Pope | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 5553 | Declan Rice | 204480 | Declan Rice | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 5555 | Dominic Calvert-Lewin | 177815 | Dominic Calvert-Lewin | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 5560 | Scott McTominay | 195851 | Scott McTominay | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 5584 | Aaron Wan-Bissaka | 214590 | Aaron Wan-Bissaka | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 5590 | Tosin Adarabioyo | 109646 | Tosin Adarabioyo | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 5595 | Daniel James | 200617 | Daniel James | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 5596 | Harry Wilson | 153682 | Harry Wilson | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 5603 | Aaron Ramsdale | 225321 | Aaron Ramsdale | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 5609 | Yves Bissouma | 227127 | Yves Bissouma | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 5613 | Gabriel | 226597 | Gabriel dos Santos Magalhães | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 5646 | Cafú | 166325 | Carlos Ribeiro Dias | name-variant | high | 1.03 | web-name-exact |
| 2223 | 5682 | Gonçalo Guedes | 181284 | Gonçalo Manuel Ganchinho Guedes | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 5712 | Diego Carlos | 165659 | Diego Carlos Santos Silva | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 5735 | Jean-Philippe Mateta | 231747 | Jean-Philippe Mateta | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 5786 | Yoane Wissa | 216646 | Yoane Wissa | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 5789 | Boubacar Kamara | 226944 | Boubacar Kamara | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 5956 | Youri Tielemans | 166989 | Youri Tielemans | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 5973 | Kenny Tete | 167074 | Kenny Tete | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 5989 | Moussa Niakhate | 199170 | Moussa Niakhaté | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 6026 | Richarlison | 212319 | Richarlison de Andrade | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6027 | Jairo Riedewald | 173954 | Jairo Riedewald | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 6030 | Zanka | 48760 | Mathias Jorgensen | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 6034 | Philip Billing | 168991 | Philip Billing | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 6042 | Jan Bednarek | 171771 | Jan Bednarek | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 6048 | Lewis Dunk | 83299 | Lewis Dunk | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6049 | Solly March | 109345 | Solly March | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6054 | Ederson | 121160 | Ederson Santana de Moraes | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 6055 | Phil Foden | 209244 | Phil Foden | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6063 | Jacob Murphy | 114243 | Jacob Murphy | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6080 | Victor Lindelöf | 184667 | Victor Lindelöf | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6088 | Orel Mangala | 179519 | Orel Mangala | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 6104 | Will Hughes | 108413 | Will Hughes | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6108 | Rodrigo Bentancur | 202993 | Rodrigo Bentancur | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6122 | Douglas Luiz | 230046 | Douglas Luiz Soares de Paulo | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6157 | Timothy Castagne | 166477 | Timothy Castagne | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6163 | Nélson Semedo | 200402 | Nélson Cabral Semedo | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 6249 | Davinson Sánchez | 173904 | Davinson Sánchez | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 6252 | Lyanco | 212721 | Lyanco Silveira Neves Vojnovic | name-variant | high | 1.03 | web-name-exact |
| 2223 | 6310 | Boubakary Soumare | 225902 | Boubakary Soumaré | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 6314 | Joachim Andersen | 174874 | Joachim Andersen | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6326 | Ibrahima Konaté | 204716 | Ibrahima Konaté | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6345 | Jadon Sancho | 209243 | Jadon Sancho | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6382 | Pedro Neto | 247632 | Pedro Lomba Neto | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6424 | Ben Johnson | 222018 | Ben Johnson | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 6482 | Eddie Nketiah | 205533 | Eddie Nketiah | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6485 | Júnior Firpo | 443967 | Junior Firpo Adames | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2223 | 6490 | Manuel Akanji | 211975 | Manuel Akanji | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 6492 | Reiss Nelson | 200641 | Reiss Nelson | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6532 | Martin Dubravka | 67089 | Martin Dubravka | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6552 | Bryan Mbeumo | 446008 | Bryan Mbeumo | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6615 | Trevoh Chalobah | 180736 | Trevoh Chalobah | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6630 | Joe Willock | 200089 | Joe Willock | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6656 | Sergio Gómez | 437468 | Sergio Gómez | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 6665 | Curtis Jones | 206915 | Curtis Jones | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6674 | Rayan Ait Nouri | 448514 | Rayan Aït-Nouri | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6681 | Harvey Barnes | 201666 | Harvey Barnes | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6691 | Dejan Kulusevski | 445044 | Dejan Kulusevski | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 6756 | Dwight McNeil | 433154 | Dwight McNeil | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6817 | Fred | 101582 | Frederico Rodrigues de Paula Santos | name-variant | high | 1.03 | web-name-exact |
| 2223 | 6818 | James Maddison | 172780 | James Maddison | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6820 | David Brooks | 111317 | David Brooks | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6827 | Bobby Reid | 96994 | Bobby De Cordova-Reid | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 6835 | Tom Cairney | 76357 | Tom Cairney | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6837 | Ryan Sessegnon | 184349 | Ryan Sessegnon | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6850 | Willy Boly | 90585 | Willy Boly | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 6851 | Conor Coady | 94147 | Conor Coady | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 6852 | Matt Doherty | 87835 | Matt Doherty | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6853 | Rúben Neves | 171317 | Rúben da Silva Neves | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2223 | 6854 | Diogo Jota | 194634 | Diogo Teixeira da Silva | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 6856 | Rúben Vinagre | 216054 | Rúben Nascimento Vinagre | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2223 | 6857 | Morgan Gibbs-White | 222531 | Morgan Gibbs-White | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6888 | William Saliba | 462424 | William Saliba | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6912 | Pedro Porro | 441164 | Pedro Porro | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6935 | Naif Aguerd | 210494 | Nayef Aguerd | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6937 | Georginio Rutter | 463067 | Georginio Rutter | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 6962 | Robin Olsen | 111782 | Robin Olsen | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 6986 | Hamed Junior Traore | 424044 | Hamed Traorè | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7069 | Saman Ghoddos | 205836 | Saman Ghoddos | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 7078 | Sean Longstaff | 180135 | Sean Longstaff | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7080 | Matheus Cunha | 430871 | Matheus Santos Carneiro Da Cunha | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7083 | Christian Nørgaard | 128295 | Christian Nørgaard | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7134 | Marc Cucurella | 179268 | Marc Cucurella Saseta | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7166 | Mathias Jensen | 207283 | Mathias Jensen | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7184 | Tim Ream | 82514 | Tim Ream | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 7198 | Oliver Skipp | 209042 | Oliver Skipp | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 7218 | Cristian Romero | 221632 | Cristian Romero | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7230 | Emile Smith-Rowe | 209289 | Emile Smith Rowe | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7235 | Jason Steele | 49262 | Jason Steele | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 7236 | Leander Dendoncker | 151589 | Leander Dendoncker | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 7240 | Benoit Badiashile Mukinayi | 242880 | Benoît Badiashile | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7281 | Diogo Dalot | 216051 | Diogo Dalot Teixeira | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7298 | Ben White | 198869 | Benjamin White | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7322 | Bukayo Saka | 223340 | Bukayo Saka | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7332 | Max Kilman | 214048 | Max Kilman | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7338 | Bryan Gil Salvatierra | 436234 | Bryan Gil Salvatierra | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 7352 | Tyler Adams | 200785 | Tyler Adams | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7365 | Lucas Paquetá | 224024 | Lucas Tolentino Coelho de Lima | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7382 | Dan Burn | 78916 | Dan Burn | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7384 | Chris Mepham | 223911 | Chris Mepham | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 7395 | Carlos Vinicius | 245824 | Carlos Vinícius Alves Morais | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 7420 | Miguel Almirón | 179018 | Miguel Almirón Rejala | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 7430 | Emerson | 241157 | Emerson Leite de Souza Junior | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 7438 | James Garner | 232928 | James Garner | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7546 | Harvey Elliott | 444884 | Harvey Elliott | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7582 | Mark Travers | 229600 | Mark Travers | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 7589 | Wesley Fofana | 444463 | Wesley Fofana | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7603 | Marc Guehi | 209036 | Marc Guéhi | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7689 | Ben Godfrey | 198826 | Ben Godfrey | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 7698 | Leandro Trossard | 116216 | Leandro Trossard | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7699 | Adam Webster | 110735 | Adam Webster | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 7702 | Dean Henderson | 172649 | Dean Henderson | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7723 | John McGinn | 122806 | John McGinn | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7726 | Ezri Konsa Ngoyo | 199798 | Ezri Konsa Ngoyo | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7752 | Gabriel Martinelli | 444145 | Gabriel Martinelli Silva | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7753 | James Justin | 220627 | James Justin | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7768 | Mason Mount | 184341 | Mason Mount | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7814 | Taiwo Awoniyi | 210156 | Taiwo Awoniyi | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7891 | Renan Lodi | 233420 | Renan Augusto Lodi dos Santos | name-variant | high | 1.03 | web-name-exact |
| 2223 | 7892 | João Félix | 428399 | João Félix Sequeira | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 7904 | Caoimhin Kelleher | 200720 | Caoimhin Kelleher | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 7921 | Felipe | 116404 | Felipe Augusto de Almeida Monteiro | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 7931 | Takehiro Tomiyasu | 223723 | Takehiro Tomiyasu | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 7988 | Billy Gilmour | 243568 | Billy Gilmour | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 8066 | Arnaut Danjuma Groeneveld | 220307 | Arnaut Danjuma | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 8067 | Reece James | 225796 | Reece James | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8089 | Kieran Tierney | 192895 | Kieran Tierney | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 8090 | Lloyd Kelly | 235530 | Lloyd Kelly | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 8119 | Boubacar Traore | 476502 | Boubacar Traoré | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 8150 | Anthony Gordon | 232826 | Anthony Gordon | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8204 | Neco Williams | 215136 | Neco Williams | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8214 | Tyrick Mitchell | 244723 | Tyrick Mitchell | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8226 | Tariq Lamptey | 232792 | Tariq Lamptey | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 8260 | Erling Haaland | 223094 | Erling Haaland | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8288 | Tomas Soucek | 215439 | Tomas Soucek | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8291 | Daniel Podence | 200600 | Daniel Castelo Podence | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 8327 | Bruno Guimarães | 208706 | Bruno Guimarães Rodriguez Moura | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8379 | Alexis Mac Allister | 243016 | Alexis Mac Allister | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8384 | Armando Broja | 440323 | Armando Broja | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8430 | Chris Richards | 427623 | Chris Richards | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8497 | Cole Palmer | 244851 | Cole Palmer | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8562 | Luke Thomas | 244619 | Luke Thomas | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 8635 | Sven Botman | 220237 | Sven Botman | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8646 | Wout Faes | 218218 | Wout Faes | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 8666 | Cheick Oumar Doucoure | 438464 | Cheick Doucouré | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 8706 | Eberechi Eze | 232413 | Eberechi Eze | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8717 | Pascal Struijk | 222694 | Pascal Struijk | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8719 | Kalvin Phillips | 155405 | Kalvin Phillips | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 8720 | Jack Harrison | 221399 | Jack Harrison | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8780 | Joël Veltman | 111478 | Joël Veltman | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8786 | Stefan Ortega Moreno | 88248 | Stefan Ortega Moreno | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8812 | Sasa Kalajdzic | 429414 | Sasa Kalajdzic | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8821 | Donny van de Beek | 180184 | Donny van de Beek | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 8845 | Hee-Chan Hwang | 184754 | Hwang Hee-chan | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8852 | Konstantinos Tsimikas | 214285 | Konstantinos Tsimikas | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 8859 | Mikkel Damsgaard | 440089 | Mikkel Damsgaard | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8864 | Matthew Cash | 199796 | Matty Cash | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8865 | Ollie Watkins | 178301 | Ollie Watkins | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8940 | Antonee Robinson | 169528 | Antonee Robinson | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8941 | Jacob Ramsey | 232653 | Jacob Ramsey | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8942 | Aaron Hickey | 472713 | Aaron Hickey | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8961 | Rúben Dias | 171314 | Rúben Gato Alves Dias | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 8965 | Vladimir Coufal | 164555 | Vladimir Coufal | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 9021 | Pape Sarr | 482442 | Pape Matar Sarr | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 9040 | Conor Gallagher | 232787 | Conor Gallagher | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 9098 | Robert Sánchez | 215059 | Robert Sánchez | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 9154 | Elliot Anderson | 215379 | Elliot Anderson | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 9156 | Kevin Schade | 513418 | Kevin Schade | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 9274 | Naouirou Ahamada | 466117 | Naouirou Ahamada | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 9324 | Facundo Pellistri | 488404 | Facundo Pellistri Rebollo | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 9356 | Carney Chukwuemeka | 478912 | Carney Chukwuemeka | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 9453 | Moisés Caicedo | 486672 | Moisés Caicedo Corozo | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 9492 | Crysencio Summerville | 450070 | Crysencio Summerville | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 9501 | Fabio Carvalho | 244858 | Fábio Freitas Gouveia Carvalho | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 9512 | Valentino Livramento | 441191 | Tino Livramento | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 9524 | Anthony Elanga | 449434 | Anthony Elanga | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 9630 | Kamaldeen Sulemana | 504783 | Kamaldeen Sulemana | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 9662 | Dango Ouattara | 533463 | Dango Ouattara | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 9667 | Amadou Onana | 449871 | Amadou Onana | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 9676 | David Raya | 154561 | David Raya Martin | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 9677 | Kristoffer Ajer | 191866 | Kristoffer Ajer | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 9678 | Ethan Pinnock | 231065 | Ethan Pinnock | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 9679 | Rico Henry | 194010 | Rico Henry | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 9680 | Vitaly Janelt | 204580 | Vitaly Janelt | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 9681 | Frank Onyeka | 428580 | Frank Onyeka | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 9685 | Mads Roerslev | 226956 | Mads Roerslev Rasmussen | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 9689 | Albert Sambi Lokonga | 437742 | Albert Sambi Lokonga | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 9710 | Armel Bella Kotchap | 477386 | Armel Bella-Kotchap | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 9733 | Nathan Collins | 432830 | Nathan Collins | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 9738 | Patson Daka | 245419 | Patson Daka | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 9739 | Kiernan Dewsbury-Hall | 215413 | Kiernan Dewsbury-Hall | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 9740 | José Sá | 149065 | José Malheiro de Sá | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 9912 | Cameron Archer | 433979 | Cameron Archer | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 9914 | Shandon Baptiste | 432160 | Shandon Baptiste | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 9948 | Michael Olise | 443661 | Michael Olise | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 10004 | Romeo Lavia | 514356 | Roméo Lavia | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 10012 | Jakub Kiwior | 440854 | Jakub Kiwior | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 10036 | Jeremy Sarmiento | 441192 | Jeremy Sarmiento Morante | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 10072 | Samuel Edozie | 490503 | Samuel Edozie | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 10140 | Hugo Bueno | 490721 | Hugo Bueno López | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 10177 | Evan Ferguson | 487117 | Evan Ferguson | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 10216 | Lewis Hall | 487838 | Lewis Hall | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 10291 | Vitalii Mykolenko | 224967 | Vitalii Mykolenko | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 10292 | Nathan Patterson | 243571 | Nathan Patterson | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 10293 | Toti | 510362 | Toti António Gomes | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 10348 | Omari Hutchinson | 503301 | Omari Hutchinson | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 10405 | Josh Dasilva | 183656 | Josh Dasilva | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 10408 | Luis Díaz | 244731 | Luis Díaz | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 10453 | Odeluga Offiah | 445548 | Odeluga Offiah | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 10536 | Tetê | 225295 | Mateus Cardoso Lemos Martins | name-variant | high | 1.03 | web-name-exact |
| 2223 | 10552 | Alejandro Garnacho | 493105 | Alejandro Garnacho | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 10715 | João Palhinha | 154296 | João Palhinha Gonçalves | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 10716 | Manor Solomon | 235674 | Manor Solomon | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 10718 | Jay Stansfield | 490146 | Jay Stansfield | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 10719 | Luke Harris | 515024 | Luke Harris | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 10720 | Darwin Núñez | 447203 | Darwin Núñez Ribeiro | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 10723 | Stefan Bajcetic | 535928 | Stefan Bajcetic | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 10741 | Marcus Tavernier | 201658 | Marcus Tavernier | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 10743 | Kieffer Moore | 128340 | Kieffer Moore | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 10744 | Ryan Christie | 158499 | Ryan Christie | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 10746 | Jaidon Anthony | 444180 | Jaidon Anthony | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 10751 | Brenden Aaronson | 427637 | Brenden Aaronson | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 10756 | Joe Worrall | 208912 | Joe Worrall | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 10757 | Scott McKenna | 168281 | Scott McKenna | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 10758 | Harry Toffolo | 114241 | Harry Toffolo | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 10760 | Brennan Johnson | 242898 | Brennan Johnson | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 10764 | Djed Spence | 232859 | Djed Spence | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 10766 | Joe Ayodele-Aribo | 193204 | Joe Ayodele-Aribo | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 10802 | Lisandro Martínez | 221820 | Lisandro Martínez | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 10803 | Tyrell Malacia | 222690 | Tyrell Malacia | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 10805 | Levi Colwill | 460028 | Levi Colwill | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 10806 | Kaoru Mitoma | 451340 | Kaoru Mitoma | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 10807 | Jan Paul van Hecke | 469142 | Jan Paul van Hecke | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 10809 | Keane Lewis-Potter | 249231 | Keane Lewis-Potter | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 10845 | Flynn Downes | 220585 | Flynn Downes | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 10846 | Julián Álvarez | 461358 | Julián Álvarez | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 10847 | Rico Lewis | 477064 | Rico Lewis | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 10864 | Marcos Senesi | 221466 | Marcos Senesi | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 10866 | Luis Sinisterra | 224995 | Luis Sinisterra Lucumí | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 10997 | Bobby Clark | 491970 | Bobby Clark | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 11000 | Matheus Nunes | 465351 | Matheus Luiz Nunes | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 11003 | Ryan Yates | 204968 | Ryan Yates | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 11007 | Fábio Vieira | 438098 | Fábio Ferreira Vieira | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 11035 | Marquinhos | 479683 | Marcus Oliveira Alencar | name-variant | high | 1.03 | web-name-exact |
| 2223 | 11058 | Julio Enciso | 474120 | Julio Enciso | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 11078 | Juan Larios | 515571 | Juan Larios López | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2223 | 11094 | Antony | 467169 | Antony Matheus dos Santos | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 11132 | Ethan Nwaneri | 499175 | Ethan Nwaneri | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 11155 | Wilfried Gnonto | 492859 | Wilfried Gnonto | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 11174 | Kobbie Mainoo | 516895 | Kobbie Mainoo | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 11208 | Mateo Joseph | 565297 | Mateo Joseph Fernández | name-variant | high | 1.03 | web-name-exact |
| 2223 | 11231 | Ben Doak | 496208 | Ben Doak | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 11232 | Thomas Cannon | 461416 | Thomas Cannon | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 11242 | Divin Mubama | 487837 | Divin Mubama | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 11268 | David Ozoh | 531989 | David Ozoh | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 11269 | Jack Hinshelwood | 532529 | Jack Hinshelwood | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 11284 | Gustavo Scarpa | 185253 | Gustavo Henrique Furtado Scarpa | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2223 | 11295 | David Datro Fofana | 520295 | David Datro Fofana | carried-forward | high | 1 | carried-from-2324 |
| 2223 | 11296 | Cody Gakpo | 243298 | Cody Gakpo | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 11297 | Carlos Alcaraz | 502697 | Carlos Alcaraz | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 11305 | Mykhailo Mudryk | 465920 | Mykhailo Mudryk | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 11317 | Danilo | 513046 | Danilo dos Santos de Oliveira | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 11356 | Enzo Fernández | 448047 | Enzo Fernández | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 11357 | Noni Madueke | 248857 | Noni Madueke | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 11359 | James Bree | 184386 | James Bree | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 11360 | Paul Onuachu | 147611 | Paul Onuachu | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 11361 | Daniel Bentley | 79602 | Daniel Bentley | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 11362 | Facundo Buonanotte | 536916 | Facundo Buonanotte | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 11363 | Antoine Semenyo | 437730 | Antoine Semenyo | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 11366 | Jhon Durán | 476344 | Jhon Durán | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 11367 | Victor Kristiansen | 481510 | Victor Kristiansen | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 11384 | João Gomes | 448089 | João Victor Gomes da Silva | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 11385 | Yasin Ayari | 509416 | Yasin Ayari | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 11386 | Lewis Miley | 547719 | Lewis Miley | carried-forward | high | 1 | carried-from-2526 |
| 2223 | 11486 | Illia Zabarnyi | 477580 | Illia Zabarnyi | carried-forward | high | 1 | carried-from-2425 |
| 2223 | 11618 | Samuel Amo-Ameyaw | 499724 | Samuel Amo-Ameyaw | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 65 | Timo Werner | 165153 | Timo Werner | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 76 | Fabian Schär | 119471 | Fabian Schär | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 87 | Joelinton | 180974 | Joelinton Cássio Apolinário de Lira | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 101 | Allan Saint-Maximin | 170137 | Allan Saint-Maximin | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 111 | Jannik Vestergaard | 93100 | Jannik Vestergaard | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 181 | Bernd Leno | 80201 | Bernd Leno | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 204 | Granit Xhaka | 84450 | Granit Xhaka | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 229 | Thiago Alcántara | 61558 | Thiago Alcántara do Nascimento | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 239 | Pascal Groß | 60307 | Pascal Groß | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 314 | Ilkay Gündogan | 59859 | Ilkay Gündogan | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 318 | Pierre-Emerick Aubameyang | 54694 | Pierre-Emerick Aubameyang | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 332 | Joel Matip | 60914 | Joel Matip | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 343 | Pierre-Emile Højbjerg | 132015 | Pierre-Emile Højbjerg | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 447 | Kevin De Bruyne | 61366 | Kevin De Bruyne | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 453 | Son Heung-Min | 85971 | Heung-Min Son | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 461 | Matt Ritchie | 56983 | Matt Ritchie | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 468 | Callum Wilson | 75115 | Callum Wilson | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 473 | Danny Ward | 95463 | Danny Ward | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 482 | Roberto Firmino | 92217 | Roberto Firmino | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 484 | Divock Origi | 152760 | Divock Origi | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 486 | Adam Lallana | 39155 | Adam Lallana | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 488 | Philippe Coutinho | 84583 | Philippe Coutinho Correia | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 489 | James Milner | 15157 | James Milner | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 496 | Mohamed Elneny | 153256 | Mohamed Naser El Sayed Elneny | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 500 | Alex Iwobi | 153133 | Alex Iwobi | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 501 | Danny Welbeck | 50175 | Danny Welbeck | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 503 | Theo Walcott | 20467 | Theo Walcott | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 508 | Calum Chambers | 101184 | Calum Chambers | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 509 | Wayne Hennessey | 20066 | Wayne Hennessey | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 510 | Joel Ward | 55494 | Joel Ward | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 522 | Wilfried Zaha | 82403 | Wilfried Zaha | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 528 | Angelo Ogbonna | 40669 | Angelo Ogbonna | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 530 | James Tomkins | 49413 | James Tomkins | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 531 | Michail Antonio | 57531 | Michail Antonio | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 532 | Cheikhou Kouyaté | 55037 | Cheikhou Kouyaté | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 534 | Aaron Cresswell | 55459 | Aaron Cresswell | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 535 | Manuel Lanzini | 86934 | Manuel Lanzini | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 546 | David de Gea | 51940 | David de Gea | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 553 | Anthony Martial | 148225 | Anthony Martial | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 556 | Marcus Rashford | 176297 | Marcus Rashford | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 558 | Jesse Lingard | 109322 | Jesse Lingard | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 579 | Nathan Aké | 126184 | Nathan Aké | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 585 | Seamus Coleman | 59949 | Seamus Coleman | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 586 | John Stones | 97299 | John Stones | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 592 | Ross Barkley | 88894 | Ross Barkley | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 603 | Nathaniel Clyne | 57328 | Nathaniel Clyne | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 605 | Jordan Henderson | 56979 | Jordan Henderson | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 614 | Fernandinho | 27789 | Fernando Luiz Rosa | name-variant | high | 1.03 | web-name-exact |
| 2122 | 618 | Raheem Sterling | 103955 | Raheem Sterling | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 620 | Kelechi Iheanacho | 173515 | Kelechi Iheanacho | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 631 | Ashley Young | 18892 | Ashley Young | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 633 | James McArthur | 50471 | James McArthur | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 635 | Alex McCarthy | 58376 | Alex McCarthy | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 637 | Hugo Lloris | 37915 | Hugo Lloris | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 638 | Kyle Walker | 58621 | Kyle Walker | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 643 | Eric Dier | 93264 | Eric Dier | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 645 | Dele Alli | 108823 | Bamidele Alli | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 646 | Christian Eriksen | 80607 | Christian Eriksen | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 647 | Harry Kane | 78830 | Harry Kane | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 652 | Kieran Trippier | 77794 | Kieran Trippier | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 660 | Ben Davies | 115556 | Ben Davies | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 672 | Jordan Ayew | 80146 | Jordan Ayew | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 675 | Jack Grealish | 114283 | Jack Grealish | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 681 | César Azpilicueta | 41328 | César Azpilicueta | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 688 | Ruben Loftus-Cheek | 126187 | Ruben Loftus-Cheek | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 689 | Kenedy | 167767 | Robert Kenedy Nunes do Nascimento | name-variant | high | 1.03 | web-name-exact |
| 2122 | 694 | Asmir Begovic | 40349 | Asmir Begović | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 695 | Bertrand Traoré | 110504 | Bertrand Traoré | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 706 | Lukasz Fabianski | 37096 | Lukasz Fabianski | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 712 | Jack Cork | 40145 | Jack Cork | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 741 | Jordan Pickford | 111234 | Jordan Pickford | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 750 | Riyad Mahrez | 103025 | Riyad Mahrez | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 751 | N&#039;Golo Kanté | 116594 | N'Golo Kanté | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 753 | Marc Albrighton | 51938 | Marc Albrighton | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 755 | Jamie Vardy | 101668 | Jamie Vardy | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 757 | Jeffrey Schlupp | 86417 | Jeffrey Schlupp | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 759 | Daniel Amartey | 155569 | Daniel Amartey | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 762 | Demarai Gray | 172632 | Demarai Gray | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 766 | Jamaal Lascelles | 101148 | Jamaal Lascelles | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 769 | Jonjo Shelvey | 50232 | Jonjo Shelvey | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 770 | Ayoze Pérez | 168580 | Ayoze Pérez | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 775 | Andros Townsend | 60252 | Andros Townsend | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 780 | Karl Darlow | 59735 | Karl Darlow | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 782 | Ben Chilwell | 172850 | Benjamin Chilwell | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 790 | Nathan Redmond | 83283 | Nathan Redmond | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 804 | Craig Dawson | 60232 | Craig Dawson | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 807 | Jonny Evans | 37642 | Jonny Evans | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 813 | Salomón Rondón | 57134 | Salomón Rondón | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 822 | Patrick Bamford | 106617 | Patrick Bamford | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 831 | Fraser Forster | 40383 | Fraser Forster | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 833 | Virgil van Dijk | 97032 | Virgil van Dijk | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 842 | Oriol Romeu | 78056 | Oriol Romeu Vidal | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 843 | James Ward-Prowse | 101178 | James Ward-Prowse | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 844 | Jay Rodriguez | 44683 | Jay Rodriguez | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 847 | Cédric Soares | 58822 | Cédric Soares | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 852 | Freddie Woodman | 155503 | Freddie Woodman | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 853 | Paul Dummett | 106618 | Paul Dummett | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 884 | Matt Targett | 169359 | Matt Targett | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 885 | Kyle Walker-Peters | 158534 | Kyle Walker-Peters | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 900 | Adama Traoré | 159533 | Adama Traoré | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 902 | Sam Byram | 113564 | Sam Byram | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 934 | Axel Tuanzebe | 180804 | Axel Tuanzebe | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 935 | Kurt Zouma | 103192 | Kurt Zouma | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 966 | Alex Oxlade-Chamberlain | 81880 | Alex Oxlade-Chamberlain | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 971 | Harry Winks | 157668 | Harry Winks | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 985 | Mason Holgate | 194164 | Mason Holgate | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 986 | Danny Ings | 84939 | Danny Ings | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 987 | Joseph Gomez | 171287 | Joseph Gomez | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 998 | Ivan Toney | 144485 | Ivan Toney | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 1006 | Luke Shaw | 106760 | Luke Shaw | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 1024 | Tyrone Mings | 149484 | Tyrone Mings | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 1042 | Tom Davies | 173807 | Tom Davies | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 1078 | Sergi Canos | 174932 | Sergi Canós | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 1142 | Samir | 162651 | Samir Caetano de Souza Santos | name-variant | high | 1.03 | web-name-exact |
| 2122 | 1228 | Bruno Fernandes | 141746 | Bruno Miguel Borges Fernandes | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 1245 | Emerson | 109533 | Emerson Palmieri dos Santos | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 1250 | Mohamed Salah | 118748 | Mohamed Salah | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 1257 | Alisson | 116535 | Alisson Ramses Becker | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 1379 | Allan | 119765 | Allan Marques Loureiro | name-variant | high | 1.03 | web-name-exact |
| 2122 | 1389 | Jorginho | 85955 | Jorge Luiz Frello Filho | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 1545 | Emil Krafth | 111773 | Emil Krafth | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 1653 | Michael Keane | 106611 | Michael Keane | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 1654 | Ben Mee | 51927 | Ben Mee | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 1663 | Johann Berg Gudmundsson | 60586 | Johann Berg Gudmundsson | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 1665 | James Tarkowski | 17761 | James Tarkowski | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 1683 | Ryan Fraser | 90105 | Ryan Fraser | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 1687 | Harry Maguire | 95658 | Harry Maguire | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 1688 | Andrew Robertson | 122798 | Andrew Robertson | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 1711 | Adam Forshaw | 80179 | Adam Forshaw | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 1719 | Javier Manquillo | 109528 | Javier Manquillo | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 1726 | Abdoulaye Doucouré | 121599 | Abdoulaye Doucouré | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 1735 | Jack Stephens | 88900 | Jack Stephens | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 1749 | Rob Holding | 156074 | Rob Holding | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 1750 | Ainsley Maitland-Niles | 154043 | Ainsley Maitland-Niles | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 1760 | Arthur Masuaku | 105717 | Arthur Masuaku | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 1776 | Jarrod Bowen | 178186 | Jarrod Bowen | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 1785 | Nampalys Mendy | 86881 | Nampalys Mendy | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 1791 | Trent Alexander-Arnold | 169187 | Trent Alexander-Arnold | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 1801 | Pontus Jansson | 61810 | Pontus Jansson | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 1823 | Lucas Digne | 101188 | Lucas Digne | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 1828 | Alex Telles | 152590 | Alex Nicolao Telles | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2122 | 2163 | Diego Llorente | 149915 | Diego Llorente | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 2190 | Vicente Guaita | 40836 | Vicente Guaita | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 2203 | Emiliano Buendía | 195546 | Emiliano Buendía Stati | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 2245 | Raphael Varane | 90152 | Raphaël Varane | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 2254 | Mateo Kovacic | 91651 | Mateo Kovacic | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 2280 | Jonny | 114128 | Jonathan Castro Otto | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 2310 | Alphonse Areola | 84182 | Alphonse Areola | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 2328 | Thomas Partey | 167199 | Thomas Partey | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 2335 | Pablo Fornals | 217593 | Pablo Fornals | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 2371 | Cristiano Ronaldo | 14937 | Cristiano Ronaldo dos Santos Aveiro | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 2379 | João Cancelo | 121145 | João Pedro Cavaco Cancelo | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 2381 | Rodrigo | 80954 | Rodrigo Moreno | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 2383 | André Gomes | 120250 | André Filipe Tavares Gomes | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 2496 | Rodri | 220566 | Rodrigo Hernandez | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 2498 | Aymeric Laporte | 146941 | Aymeric Laporte | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 2517 | Martin Odegaard | 184029 | Martin Ødegaard | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 2662 | Christian Pulisic | 176413 | Christian Pulisic | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 2958 | Oleksandr Zinchenko | 206325 | Oleksandr Zinchenko | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 3203 | Issa Diop | 219924 | Issa Diop | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 3278 | Maxwel Cornet | 149519 | Maxwel Cornet | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 3288 | Thiago Silva | 51090 | Thiago Emiliano da Silva | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 3293 | Lucas Moura | 95715 | Lucas Rodrigues Moura da Silva | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 3303 | Ricardo Pereira | 111931 | Ricardo Domingos Barbosa Pereira | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 3420 | Fabinho | 116643 | Fabio Henrique Tavares | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 3422 | João Moutinho | 19624 | João Filipe Iria Santos Moutinho | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 3428 | Hélder Costa | 165808 | Hélder Wander Sousa de Azevedo e Costa | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2122 | 3585 | Said Benrahma | 172841 | Saïd Benrahma | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 3621 | Neal Maupay | 115382 | Neal Maupay | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 3635 | Bernardo Silva | 165809 | Bernardo Mota Veiga de Carvalho e Silva | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 3696 | Morgan Sanson | 122775 | Morgan Sanson | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 3697 | Odsonne Edouard | 199670 | Odsonne Edouard | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 4105 | Raúl Jiménez | 102057 | Raúl Jiménez | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 4381 | Mateusz Klich | 72222 | Mateusz Klich | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 4401 | Emiliano Martinez | 98980 | Emiliano Martínez | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 4419 | Adam Armstrong | 155511 | Adam Armstrong | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 4422 | Ashley Barnes | 44699 | Ashley Barnes | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 4456 | Chris Wood | 60689 | Chris Wood | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 5043 | Kiko Femenía | 54484 | Francisco Femenía Far | name-variant | high | 1.04 | team-and-first-name-season-stats-supported |
| 2122 | 5061 | Kepa | 109745 | Kepa Arrizabalaga | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 5220 | Kai Havertz | 219847 | Kai Havertz | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 5221 | Leon Bailey | 215711 | Leon Bailey | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 5247 | Naby Keita | 175592 | Naby Keita | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 5264 | Caglar Söyüncü | 218031 | Çaglar Söyüncü | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 5543 | Gabriel Jesus | 205651 | Gabriel Fernando de Jesus | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 5544 | Angus Gunn | 107265 | Angus Gunn | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 5545 | Wilfred Ndidi | 203341 | Wilfred Ndidi | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 5549 | Luka Milivojevic | 66975 | Luka Milivojevic | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 5552 | Nick Pope | 98747 | Nick Pope | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 5553 | Declan Rice | 204480 | Declan Rice | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 5555 | Dominic Calvert-Lewin | 177815 | Dominic Calvert-Lewin | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 5560 | Scott McTominay | 195851 | Scott McTominay | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 5568 | Connor Roberts | 192290 | Connor Roberts | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 5584 | Aaron Wan-Bissaka | 214590 | Aaron Wan-Bissaka | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 5595 | Daniel James | 200617 | Daniel James | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 5603 | Aaron Ramsdale | 225321 | Aaron Ramsdale | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 5609 | Yves Bissouma | 227127 | Yves Bissouma | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 5613 | Gabriel | 226597 | Gabriel Magalhães | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 5675 | Ismaila Sarr | 232185 | Ismaila Sarr | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 5681 | Giovani Lo Celso | 200826 | Giovani Lo Celso | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 5735 | Jean-Philippe Mateta | 231747 | Jean-Philippe Mateta | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 5786 | Yoane Wissa | 216646 | Yoane Wissa | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 5956 | Youri Tielemans | 166989 | Youri Tielemans | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 5962 | Tanguy NDombele Alvaro | 231372 | Tanguy Ndombele | name-variant | high | 1.06 | team-and-shared-name-tokens |
| 2122 | 6026 | Richarlison | 212319 | Richarlison de Andrade | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6027 | Jairo Riedewald | 173954 | Jairo Riedewald | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 6030 | Zanka | 48760 | Mathias Jorgensen | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 6042 | Jan Bednarek | 171771 | Jan Bednarek | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 6044 | Charlie Taylor | 103914 | Charlie Taylor | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 6047 | Shane Duffy | 61933 | Shane Duffy | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 6048 | Lewis Dunk | 83299 | Lewis Dunk | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6049 | Solly March | 109345 | Solomon March | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6054 | Ederson | 121160 | Ederson Santana de Moraes | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 6055 | Phil Foden | 209244 | Phil Foden | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6063 | Jacob Murphy | 114243 | Jacob Murphy | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6080 | Victor Lindelöf | 184667 | Victor Lindelöf | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6104 | Will Hughes | 108413 | Will Hughes | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6108 | Rodrigo Bentancur | 202993 | Rodrigo Bentancur | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6122 | Douglas Luiz | 230046 | Douglas Luiz Soares de Paulo | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6157 | Timothy Castagne | 166477 | Timothy Castagne | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6163 | Nélson Semedo | 200402 | Nélson Cabral Semedo | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 6249 | Davinson Sánchez | 173904 | Davinson Sánchez | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 6252 | Lyanco | 212721 | Lyanco Evangelista Silveira Neves Vojnovic | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 6273 | Robin Koch | 193645 | Robin Koch | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 6310 | Boubakary Soumare | 225902 | Boubakary Soumaré | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 6314 | Joachim Andersen | 174874 | Joachim Andersen | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6326 | Ibrahima Konaté | 204716 | Ibrahima Konaté | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6345 | Jadon Sancho | 209243 | Jadon Sancho | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6377 | Joe Rodon | 214225 | Joe Rodon | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6382 | Pedro Neto | 247632 | Pedro Lomba Neto | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6418 | Hamza Choudhury | 197469 | Hamza Choudhury | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 6424 | Ben Johnson | 222018 | Ben Johnson | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 6456 | Callum Hudson-Odoi | 209046 | Callum Hudson-Odoi | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6482 | Eddie Nketiah | 205533 | Edward Nketiah | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6485 | Júnior Firpo | 443967 | Héctor Junior Firpo Adames | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 6492 | Reiss Nelson | 200641 | Reiss Nelson | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6500 | Romain Perraud | 244560 | Romain Perraud | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 6521 | Yerry Mina | 164511 | Yerry Mina | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 6532 | Martin Dubravka | 67089 | Martin Dubravka | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6538 | Oghenekaro Etebo | 227560 | Oghenekaro Peter Etebo | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2122 | 6552 | Bryan Mbeumo | 446008 | Bryan Mbeumo | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6615 | Trevoh Chalobah | 180736 | Trevoh Chalobah | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6630 | Joe Willock | 200089 | Joseph Willock | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6665 | Curtis Jones | 206915 | Curtis Jones | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6674 | Rayan Ait Nouri | 448514 | Rayan Ait Nouri | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6681 | Harvey Barnes | 201666 | Harvey Barnes | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6691 | Dejan Kulusevski | 445044 | Dejan Kulusevski | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 6736 | Ibrahima Diallo | 240143 | Ibrahima Diallo | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 6756 | Dwight McNeil | 433154 | Dwight McNeil | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6817 | Fred | 101582 | Frederico Rodrigues de Paula Santos | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 6818 | James Maddison | 172780 | James Maddison | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6837 | Ryan Sessegnon | 184349 | Ryan Sessegnon | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6850 | Willy Boly | 90585 | Willy Boly | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 6851 | Conor Coady | 94147 | Conor Coady | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 6852 | Matt Doherty | 87835 | Matt Doherty | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6853 | Rúben Neves | 171317 | Rúben Diogo da Silva Neves | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 6854 | Diogo Jota | 194634 | Diogo Jota | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 6857 | Morgan Gibbs-White | 222531 | Morgan Gibbs-White | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 6880 | Edouard Mendy | 228286 | Edouard Mendy | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 6891 | Ryan Fredericks | 81012 | Ryan Fredericks | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 6893 | Stuart Armstrong | 91047 | Stuart Armstrong | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 6894 | Mohamed Elyounoussi | 96787 | Mohamed Elyounoussi | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 6923 | Mohammed Salisu | 450527 | Mohammed Salisu | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 6954 | Juan Camilo Hernández | 244716 | Juan Camilo Hernández Suárez | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2122 | 6962 | Robin Olsen | 111782 | Robin Olsen | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 7052 | Wout Weghorst | 120202 | Wout Weghorst | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 7069 | Saman Ghoddos | 205836 | Saman Ghoddos | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 7078 | Sean Longstaff | 180135 | Sean Longstaff | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 7083 | Christian Nørgaard | 128295 | Christian Nørgaard | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 7134 | Marc Cucurella | 179268 | Marc Cucurella | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 7166 | Mathias Jensen | 207283 | Mathias Jensen | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 7187 | Sergio Reguilón | 199249 | Sergio Reguilón | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 7198 | Oliver Skipp | 209042 | Oliver Skipp | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 7218 | Cristian Romero | 221632 | Cristian Romero | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 7230 | Emile Smith-Rowe | 209289 | Emile Smith Rowe | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 7235 | Jason Steele | 49262 | Jason Steele | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 7236 | Leander Dendoncker | 151589 | Leander Dendoncker | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 7280 | Yan Valery | 213482 | Yan Valery | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 7281 | Diogo Dalot | 216051 | José Diogo Dalot Teixeira | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 7298 | Ben White | 198869 | Ben White | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 7322 | Bukayo Saka | 223340 | Bukayo Saka | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 7332 | Max Kilman | 214048 | Max Kilman | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 7338 | Bryan Gil Salvatierra | 436234 | Bryan Gil Salvatierra | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 7382 | Dan Burn | 78916 | Dan Burn | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 7420 | Miguel Almirón | 179018 | Miguel Almirón | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 7430 | Emerson | 241157 | Emerson Aparecido Leite de Souza Junior | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 7546 | Harvey Elliott | 444884 | Harvey Elliott | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 7589 | Wesley Fofana | 444463 | Wesley Fofana | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 7603 | Marc Guehi | 209036 | Marc Guéhi | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 7688 | Max Aarons | 232980 | Max Aarons | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 7689 | Ben Godfrey | 198826 | Ben Godfrey | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 7691 | Jamal Lewis | 194799 | Jamal Lewis | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 7698 | Leandro Trossard | 116216 | Leandro Trossard | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 7699 | Adam Webster | 110735 | Adam Webster | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 7700 | Che Adams | 200439 | Che Adams | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 7701 | Moussa Djenepo | 431131 | Moussa Djenepo | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 7722 | Trézéguet | 148508 | Mahmoud Ahmed Ibrahim Hassan | name-variant | high | 1.03 | web-name-exact |
| 2122 | 7723 | John McGinn | 122806 | John McGinn | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 7724 | Wesley | 213345 | Wesley Moraes | name-variant | high | 1.03 | web-name-exact |
| 2122 | 7726 | Ezri Konsa Ngoyo | 199798 | Ezri Konsa Ngoyo | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 7752 | Gabriel Martinelli | 444145 | Gabriel Teodoro Martinelli Silva | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 7753 | James Justin | 220627 | James Justin | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 7768 | Mason Mount | 184341 | Mason Mount | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 7904 | Caoimhin Kelleher | 200720 | Caoimhin Kelleher | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 7931 | Takehiro Tomiyasu | 223723 | Takehiro Tomiyasu | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 7988 | Billy Gilmour | 243568 | Billy Gilmour | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 8026 | Raphinha | 219961 | Raphael Dias Belloli | name-variant | high | 1.03 | web-name-exact |
| 2122 | 8040 | Marvelous Nakamba | 184704 | Marvelous Nakamba | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 8067 | Reece James | 225796 | Reece James | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 8089 | Kieran Tierney | 192895 | Kieran Tierney | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 8150 | Anthony Gordon | 232826 | Anthony Gordon | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 8204 | Neco Williams | 215136 | Neco Williams | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 8214 | Tyrick Mitchell | 244723 | Tyrick Mitchell | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 8222 | Japhet Tanganga | 199584 | Japhet Tanganga | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 8224 | William Smallbone | 214466 | William Smallbone | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 8226 | Tariq Lamptey | 232792 | Tariq Lamptey | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 8272 | João Pedro | 475168 | João Pedro Junqueira de Jesus | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 8288 | Tomas Soucek | 215439 | Tomas Soucek | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 8291 | Daniel Podence | 200600 | Daniel Castelo Podence | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 8323 | Josh Brownhill | 172782 | Josh Brownhill | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 8327 | Bruno Guimarães | 208706 | Bruno Guimarães Rodriguez Moura | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 8351 | Ki-Jana Hoever | 441271 | Ki-Jana Hoever | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 8379 | Alexis Mac Allister | 243016 | Alexis Mac Allister | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 8384 | Armando Broja | 440323 | Armando Broja | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 8476 | Jarrad Branthwaite | 480455 | Jarrad Branthwaite | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 8497 | Cole Palmer | 244851 | Cole Palmer | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 8562 | Luke Thomas | 244619 | Luke Thomas | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 8582 | Ellis Simms | 218997 | Ellis Simms | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 8706 | Eberechi Eze | 232413 | Eberechi Eze | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 8715 | Illan Meslier | 437495 | Illan Meslier | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 8716 | Luke Ayling | 66588 | Luke Ayling | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 8717 | Pascal Struijk | 222694 | Pascal Struijk | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 8719 | Kalvin Phillips | 155405 | Kalvin Phillips | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 8720 | Jack Harrison | 221399 | Jack Harrison | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 8778 | Fabio Silva | 449988 | Fabio Silva | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 8780 | Joël Veltman | 111478 | Joël Veltman | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 8816 | Liam Cooper | 55914 | Liam Cooper | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 8821 | Donny van de Beek | 180184 | Donny van de Beek | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 8845 | Hee-Chan Hwang | 184754 | Hee-Chan Hwang | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 8852 | Konstantinos Tsimikas | 214285 | Konstantinos Tsimikas | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 8864 | Matthew Cash | 199796 | Matthew Cash | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 8865 | Ollie Watkins | 178301 | Ollie Watkins | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 8868 | Liam Delap | 463034 | Liam Delap | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 8934 | Trincão | 222564 | Francisco Machado Mota de Castro Trincão | name-variant | high | 1.03 | web-name-exact |
| 2122 | 8941 | Jacob Ramsey | 232653 | Jacob Ramsey | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 8961 | Rúben Dias | 171314 | Rúben Santos Gato Alves Dias | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 8965 | Vladimir Coufal | 164555 | Vladimir Coufal | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 8992 | Hakim Ziyech | 124183 | Hakim Ziyech | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 9040 | Conor Gallagher | 232787 | Conor Gallagher | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 9098 | Robert Sánchez | 215059 | Robert Sánchez | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 9284 | Jakub Moder | 243505 | Jakub Moder | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 9287 | Tyler Onyango | 461446 | Tyler Onyango | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 9301 | Emmanuel Dennis | 230251 | Emmanuel Dennis | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 9332 | Dane Scarlett | 490145 | Dane Scarlett | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 9339 | Joe Gelhardt | 462635 | Joe Gelhardt | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 9356 | Carney Chukwuemeka | 478912 | Carney Chukwuemeka | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 9415 | Jaden Philogene-Bidace | 481624 | Jaden Philogene-Bidace | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 9453 | Moisés Caicedo | 486672 | Moisés Caicedo | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 9461 | Jesurun Rak-Sakyi | 450542 | Jesurun Rak-Sakyi | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 9470 | Isaac Price | 491559 | Isaac Price | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 9492 | Crysencio Summerville | 450070 | Crysencio Summerville | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 9493 | Sam Greenwood | 248937 | Sam Greenwood | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 9499 | Cody Drameh | 433590 | Cody Drameh | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 9512 | Valentino Livramento | 441191 | Tino Livramento | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 9524 | Anthony Elanga | 449434 | Anthony Elanga | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 9554 | Tim Iroegbunam | 490094 | Tim Iroegbunam | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 9558 | Hannibal Mejbri | 465527 | Hannibal Mejbri | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 9676 | David Raya | 154561 | David Raya Martin | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 9677 | Kristoffer Ajer | 191866 | Kristoffer Ajer | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 9678 | Ethan Pinnock | 231065 | Ethan Pinnock | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 9679 | Rico Henry | 194010 | Rico Henry | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 9680 | Vitaly Janelt | 204580 | Vitaly Janelt | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 9681 | Frank Onyeka | 428580 | Frank Onyeka | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 9683 | Mads Bech Sørensen | 228044 | Mads Bech Sørensen | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 9685 | Mads Roerslev | 226956 | Mads Roerslev Rasmussen | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 9689 | Albert Sambi Lokonga | 437742 | Albert Sambi Lokonga | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 9691 | Nuno Tavares | 437626 | Nuno Varela Tavares | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 9733 | Nathan Collins | 432830 | Nathan Collins | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 9734 | Enock Mwepu | 423649 | Enock Mwepu | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 9738 | Patson Daka | 245419 | Patson Daka | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 9739 | Kiernan Dewsbury-Hall | 215413 | Kiernan Dewsbury-Hall | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 9740 | José Sá | 149065 | José Malheiro de Sá | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 9741 | Chem Campbell | 461026 | Chem Campbell | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 9833 | Andrew Omobamidele | 466404 | Andrew Omobamidele | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 9912 | Cameron Archer | 433979 | Cameron Archer | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 9914 | Shandon Baptiste | 432160 | Shandon Baptiste | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 9948 | Michael Olise | 443661 | Michael Olise | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 10027 | Lewis Dobbin | 461421 | Lewis Dobbin | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 10036 | Jeremy Sarmiento | 441192 | Jeremy Sarmiento | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 10118 | Kaide Gordon | 496185 | Kaide Gordon | carried-forward | high | 1 | carried-from-2324 |
| 2122 | 10126 | James McAtee | 432714 | James McAtee | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 10166 | Kasey McAteer | 461587 | Kasey McAteer | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 10168 | Lewis Brunt | 232620 | Lewis Brunt | carried-forward | high | 1 | carried-from-2223 |
| 2122 | 10174 | CJ Egan-Riley | 432711 | Conrad Egan-Riley | name-variant | high | 1.035 | team-and-shared-name-tokens |
| 2122 | 10177 | Evan Ferguson | 487117 | Evan Ferguson | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 10203 | Kayky | 478028 | Kayky da Silva Chagas | name-variant | high | 1.03 | web-name-exact |
| 2122 | 10291 | Vitalii Mykolenko | 224967 | Vitalii Mykolenko | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 10293 | Toti | 510362 | Toti António Gomes | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 10327 | Chiquinho | 510363 | Francisco Jorge Tomás Oliveira | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 10405 | Josh Dasilva | 183656 | Pelenda Joshua Dasilva | carried-forward | high | 1 | carried-from-2526 |
| 2122 | 10408 | Luis Díaz | 244731 | Luis Díaz | carried-forward | high | 1 | carried-from-2425 |
| 2122 | 10552 | Alejandro Garnacho | 493105 | Alejandro Garnacho Ferreyra | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 65 | Timo Werner | 165153 | Timo Werner | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 76 | Fabian Schär | 119471 | Fabian Schär | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 87 | Joelinton | 180974 | Joelinton Cássio Apolinário de Lira | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 101 | Allan Saint-Maximin | 170137 | Allan Saint-Maximin | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 111 | Jannik Vestergaard | 93100 | Jannik Vestergaard | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 181 | Bernd Leno | 80201 | Bernd Leno | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 200 | Andreas Christensen | 135363 | Andreas Christensen | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 204 | Granit Xhaka | 84450 | Granit Xhaka | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 229 | Thiago Alcántara | 61558 | Thiago Alcántara do Nascimento | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 239 | Pascal Groß | 60307 | Pascal Groß | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 314 | Ilkay Gündogan | 59859 | Ilkay Gündogan | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 318 | Pierre-Emerick Aubameyang | 54694 | Pierre-Emerick Aubameyang | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 332 | Joel Matip | 60914 | Joel Matip | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 342 | Sead Kolasinac | 111457 | Sead Kolasinac | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 343 | Pierre-Emile Højbjerg | 132015 | Pierre-Emile Højbjerg | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 447 | Kevin De Bruyne | 61366 | Kevin De Bruyne | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 453 | Son Heung-Min | 85971 | Heung-Min Son | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 461 | Matt Ritchie | 56983 | Matt Ritchie | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 465 | Joshua King | 78007 | Joshua King | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 468 | Callum Wilson | 75115 | Callum Wilson | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 482 | Roberto Firmino | 92217 | Roberto Firmino | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 484 | Divock Origi | 152760 | Divock Origi | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 486 | Adam Lallana | 39155 | Adam Lallana | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 489 | James Milner | 15157 | James Milner | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 496 | Mohamed Elneny | 153256 | Mohamed Naser El Sayed Elneny | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 500 | Alex Iwobi | 153133 | Alex Iwobi | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 501 | Danny Welbeck | 50175 | Danny Welbeck | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 503 | Theo Walcott | 20467 | Theo Walcott | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 508 | Calum Chambers | 101184 | Calum Chambers | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 510 | Joel Ward | 55494 | Joel Ward | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 522 | Wilfried Zaha | 82403 | Wilfried Zaha | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 527 | Adrián | 60706 | Adrián San Miguel del Castillo | name-variant | high | 1.03 | web-name-exact |
| 2021 | 528 | Angelo Ogbonna | 40669 | Angelo Ogbonna | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 530 | James Tomkins | 49413 | James Tomkins | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 531 | Michail Antonio | 57531 | Michail Antonio | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 532 | Cheikhou Kouyaté | 55037 | Cheikhou Kouyaté | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 533 | Mark Noble | 18073 | Mark Noble | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 534 | Aaron Cresswell | 55459 | Aaron Cresswell | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 535 | Manuel Lanzini | 86934 | Manuel Lanzini | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 546 | David de Gea | 51940 | David de Gea | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 553 | Anthony Martial | 148225 | Anthony Martial | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 554 | Juan Mata | 43670 | Juan Mata | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 556 | Marcus Rashford | 176297 | Marcus Rashford | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 558 | Jesse Lingard | 109322 | Jesse Lingard | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 579 | Nathan Aké | 126184 | Nathan Aké | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 585 | Seamus Coleman | 59949 | Seamus Coleman | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 586 | John Stones | 97299 | John Stones | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 592 | Ross Barkley | 88894 | Ross Barkley | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 603 | Nathaniel Clyne | 57328 | Nathaniel Clyne | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 605 | Jordan Henderson | 56979 | Jordan Henderson | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 606 | Christian Benteke | 54861 | Christian Benteke | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 614 | Fernandinho | 27789 | Fernando Luiz Rosa | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 618 | Raheem Sterling | 103955 | Raheem Sterling | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 620 | Kelechi Iheanacho | 173515 | Kelechi Iheanacho | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 624 | Willy Caballero | 20310 | Willy Caballero | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 633 | James McArthur | 50471 | James McArthur | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 635 | Alex McCarthy | 58376 | Alex McCarthy | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 637 | Hugo Lloris | 37915 | Hugo Lloris | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 638 | Kyle Walker | 58621 | Kyle Walker | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 643 | Eric Dier | 93264 | Eric Dier | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 645 | Dele Alli | 108823 | Bamidele Alli | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 647 | Harry Kane | 78830 | Harry Kane | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 660 | Ben Davies | 115556 | Ben Davies | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 661 | Josh Onomah | 168765 | Josh Onomah | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 669 | Ashley Westwood | 60551 | Ashley Westwood | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 672 | Jordan Ayew | 80146 | Jordan Ayew | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 675 | Jack Grealish | 114283 | Jack Grealish | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 681 | César Azpilicueta | 41328 | César Azpilicueta | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 688 | Ruben Loftus-Cheek | 126187 | Ruben Loftus-Cheek | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 695 | Bertrand Traoré | 110504 | Bertrand Traoré | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 697 | Nemanja Matic | 62398 | Nemanja Matic | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 700 | Willian | 47431 | Willian Borges Da Silva | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 702 | Tammy Abraham | 173879 | Tammy Abraham | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 706 | Lukasz Fabianski | 37096 | Lukasz Fabianski | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 708 | Federico Fernández | 57145 | Federico Fernández | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 712 | Jack Cork | 40145 | Jack Cork | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 725 | Ola Aina | 159506 | Ola Aina | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 741 | Jordan Pickford | 111234 | Jordan Pickford | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 743 | Dwight Gayle | 104547 | Dwight Gayle | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 745 | Kasper Schmeichel | 17745 | Kasper Schmeichel | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 750 | Riyad Mahrez | 103025 | Riyad Mahrez | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 751 | N&#039;Golo Kanté | 116594 | N'Golo Kanté | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 753 | Marc Albrighton | 51938 | Marc Albrighton | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 755 | Jamie Vardy | 101668 | Jamie Vardy | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 757 | Jeffrey Schlupp | 86417 | Jeffrey Schlupp | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 759 | Daniel Amartey | 155569 | Daniel Amartey | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 762 | Demarai Gray | 172632 | Demarai Gray | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 766 | Jamaal Lascelles | 101148 | Jamaal Lascelles | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 769 | Jonjo Shelvey | 50232 | Jonjo Shelvey | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 770 | Ayoze Pérez | 168580 | Ayoze Pérez | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 772 | Moussa Sissoko | 45268 | Moussa Sissoko | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 773 | Aleksandar Mitrovic | 128389 | Aleksandar Mitrović | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 775 | Andros Townsend | 60252 | Andros Townsend | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 780 | Karl Darlow | 59735 | Karl Darlow | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 782 | Ben Chilwell | 172850 | Benjamin Chilwell | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 785 | John Ruddy | 19236 | John Ruddy | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 790 | Nathan Redmond | 83283 | Nathan Redmond | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 804 | Craig Dawson | 60232 | Craig Dawson | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 807 | Jonny Evans | 37642 | Jonny Evans | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 822 | Patrick Bamford | 106617 | Patrick Bamford | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 831 | Fraser Forster | 40383 | Fraser Forster | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 833 | Virgil van Dijk | 97032 | Virgil van Dijk | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 835 | Ryan Bertrand | 40146 | Ryan Bertrand | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 838 | Sadio Mané | 110979 | Sadio Mané | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 839 | Shane Long | 20452 | Shane Long | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 842 | Oriol Romeu | 78056 | Oriol Romeu Vidal | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 843 | James Ward-Prowse | 101178 | James Ward-Prowse | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 844 | Jay Rodriguez | 44683 | Jay Rodriguez | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 847 | Cédric Soares | 58822 | Cédric Soares | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 853 | Paul Dummett | 106618 | Paul Dummett | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 856 | Jack Butland | 105666 | Jack Butland | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 875 | Ciaran Clark | 58845 | Ciaran Clark | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 876 | Fabian Delph | 41823 | Fabian Delph | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 884 | Matt Targett | 169359 | Matt Targett | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 885 | Kyle Walker-Peters | 158534 | Kyle Walker-Peters | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 887 | Erik Pieters | 39487 | Erik Pieters | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 900 | Adama Traoré | 159533 | Adama Traoré | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 910 | Harrison Reed | 153366 | Harrison Reed | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 934 | Axel Tuanzebe | 180804 | Axel Tuanzebe | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 935 | Kurt Zouma | 103192 | Kurt Zouma | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 966 | Alex Oxlade-Chamberlain | 81880 | Alex Oxlade-Chamberlain | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 971 | Harry Winks | 157668 | Harry Winks | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 978 | Sam Johnstone | 101982 | Sam Johnstone | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 985 | Mason Holgate | 194164 | Mason Holgate | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 986 | Danny Ings | 84939 | Danny Ings | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 987 | Joseph Gomez | 171287 | Joseph Gomez | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 1006 | Luke Shaw | 106760 | Luke Shaw | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 1014 | Tyler Roberts | 173821 | Tyler Roberts | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 1017 | Matej Vydra | 81183 | Matej Vydra | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 1024 | Tyrone Mings | 149484 | Tyrone Mings | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 1042 | Tom Davies | 173807 | Tom Davies | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 1053 | Keinan Davis | 221239 | Keinan Davis | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 1084 | Jonjoe Kenny | 153673 | Jonjoe Kenny | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 1208 | Felipe Anderson | 101537 | Felipe Anderson Pereira Gomes | name-variant | high | 1.03 | web-name-exact |
| 2021 | 1228 | Bruno Fernandes | 141746 | Bruno Miguel Borges Fernandes | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 1234 | Dennis Praet | 106837 | Dennis Praet | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 1245 | Emerson | 109533 | Emerson Palmieri dos Santos | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 1250 | Mohamed Salah | 118748 | Mohamed Salah | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 1257 | Alisson | 116535 | Alisson Ramses Becker | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 1299 | Mario Lemina | 151086 | Mario Lemina | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 1304 | Moise Kean | 242058 | Moise Kean | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 1379 | Allan | 119765 | Allan Marques Loureiro | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 1389 | Jorginho | 85955 | Jorge Luiz Frello Filho | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 1545 | Emil Krafth | 111773 | Emil Krafth | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 1621 | Marcos Alonso | 82263 | Marcos Alonso | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 1652 | Matthew Lowton | 68983 | Matthew Lowton | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 1653 | Michael Keane | 106611 | Michael Keane | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 1654 | Ben Mee | 51927 | Ben Mee | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 1663 | Johann Berg Gudmundsson | 60586 | Johann Berg Gudmundsson | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 1665 | James Tarkowski | 17761 | James Tarkowski | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 1676 | David Luiz | 41270 | David Luiz Moreira Marinho | name-variant | high | 1.03 | web-name-exact |
| 2021 | 1683 | Ryan Fraser | 90105 | Ryan Fraser | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 1687 | Harry Maguire | 95658 | Harry Maguire | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 1688 | Andrew Robertson | 122798 | Andrew Robertson | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 1719 | Javier Manquillo | 109528 | Javier Manquillo | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 1726 | Abdoulaye Doucouré | 121599 | Abdoulaye Doucouré | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 1735 | Jack Stephens | 88900 | Jack Stephens | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 1736 | Oliver McBurnie | 169432 | Oliver McBurnie | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 1739 | Eric Bailly | 197365 | Eric Bailly | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 1740 | Paul Pogba | 74208 | Paul Pogba | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 1746 | Jeff Hendrick | 83314 | Jeff Hendrick | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 1747 | Kevin Long | 41674 | Kevin Long | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 1749 | Rob Holding | 156074 | Rob Holding | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 1750 | Ainsley Maitland-Niles | 154043 | Ainsley Maitland-Niles | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 1760 | Arthur Masuaku | 105717 | Arthur Masuaku | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 1776 | Jarrod Bowen | 178186 | Jarrod Bowen | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 1785 | Nampalys Mendy | 86881 | Nampalys Mendy | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 1791 | Trent Alexander-Arnold | 169187 | Trent Alexander-Arnold | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 1822 | Antonio Rüdiger | 102380 | Antonio Rüdiger | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 1823 | Lucas Digne | 101188 | Lucas Digne | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 1828 | Alex Telles | 152590 | Alex Nicolao Telles | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 2163 | Diego Llorente | 149915 | Diego Llorente | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 2164 | Pablo Hernández | 28690 | Pablo Hernández Domínguez | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2021 | 2190 | Vicente Guaita | 40836 | Vicente Guaita | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 2254 | Mateo Kovacic | 91651 | Mateo Kovacic | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 2259 | Kiko Casilla | 39790 | Francisco Casilla Cortés | name-variant | high | 1.04 | team-and-first-name-season-stats-supported |
| 2021 | 2280 | Jonny | 114128 | Jonathan Castro Otto | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 2310 | Alphonse Areola | 84182 | Alphonse Areola | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 2328 | Thomas Partey | 167199 | Thomas Partey | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 2335 | Pablo Fornals | 217593 | Pablo Fornals | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 2361 | Willian José | 73314 | Willian José Da Silva | name-variant | high | 1.03 | web-name-exact |
| 2021 | 2379 | João Cancelo | 121145 | João Pedro Cavaco Cancelo | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 2381 | Rodrigo | 80954 | Rodrigo Moreno | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 2383 | André Gomes | 120250 | André Filipe Tavares Gomes | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 2385 | Mat Ryan | 131897 | Mathew Ryan | name-variant | high | 1.045 | team-and-shared-name-tokens |
| 2021 | 2446 | Dani Ceballos | 182539 | Daniel Ceballos Fernández | name-variant | high | 1.05 | team-and-shared-name-tokens |
| 2021 | 2496 | Rodri | 220566 | Rodrigo Hernandez | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 2498 | Aymeric Laporte | 146941 | Aymeric Laporte | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 2517 | Martin Odegaard | 184029 | Martin Ødegaard | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 2662 | Christian Pulisic | 176413 | Christian Pulisic | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 2958 | Oleksandr Zinchenko | 206325 | Oleksandr Zinchenko | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 3203 | Issa Diop | 219924 | Issa Diop | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 3277 | Alexandre Lacazette | 59966 | Alexandre Lacazette | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 3288 | Thiago Silva | 51090 | Thiago Thiago | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 3293 | Lucas Moura | 95715 | Lucas Rodrigues Moura da Silva | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 3294 | Edinson Cavani | 40720 | Edinson Cavani | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 3303 | Ricardo Pereira | 111931 | Ricardo Domingos Barbosa Pereira | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 3389 | Benjamin Mendy | 102826 | Benjamin Mendy | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 3420 | Fabinho | 116643 | Fabio Henrique Tavares | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 3422 | João Moutinho | 19624 | João Filipe Iria Santos Moutinho | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 3428 | Hélder Costa | 165808 | Hélder Wander Sousa de Azevedo e Costa | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 3491 | Romain Saiss | 107613 | Romain Saïss | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 3585 | Said Benrahma | 172841 | Saïd Benrahma | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 3600 | Serge Aurier | 80226 | Serge Aurier | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 3621 | Neal Maupay | 115382 | Neal Maupay | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 3635 | Bernardo Silva | 165809 | Bernardo Mota Veiga de Carvalho e Silva | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 3683 | Ivan Cavaleiro | 166324 | Ivan Ricardo Neves Abreu Cavaleiro | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2021 | 3696 | Morgan Sanson | 122775 | Morgan Sanson | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 3979 | Ahmed Hegazy | 77777 | Ahmed El-Sayed Hegazy | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2021 | 4105 | Raúl Jiménez | 102057 | Raúl Jiménez | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 4381 | Mateusz Klich | 72222 | Mateusz Klich | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 4401 | Emiliano Martinez | 98980 | Emiliano Martínez | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 4422 | Ashley Barnes | 44699 | Ashley Barnes | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 4456 | Chris Wood | 60689 | Chris Wood | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 4490 | Semi Ajayi | 146426 | Oluwasemilogo Adesewo Ibidapo Ajayi | name-variant | high | 1.039 | team-and-shared-name-tokens |
| 2021 | 4764 | Jean-Philippe Gbamin | 160987 | Jean-Philippe Gbamin | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 5061 | Kepa | 109745 | Kepa Arrizabalaga | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 5220 | Kai Havertz | 219847 | Kai Havertz | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 5245 | Bernardo | 209362 | Bernardo Fernandes da Silva Junior | name-variant | high | 1.03 | web-name-exact |
| 2021 | 5247 | Naby Keita | 175592 | Naby Keita | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 5264 | Caglar Söyüncü | 218031 | Çaglar Söyüncü | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 5543 | Gabriel Jesus | 205651 | Gabriel Fernando de Jesus | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 5545 | Wilfred Ndidi | 203341 | Wilfred Ndidi | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 5549 | Luka Milivojevic | 66975 | Luka Milivojevic | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 5552 | Nick Pope | 98747 | Nick Pope | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 5553 | Declan Rice | 204480 | Declan Rice | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 5555 | Dominic Calvert-Lewin | 177815 | Dominic Calvert-Lewin | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 5556 | Ademola Lookman | 219352 | Ademola Lookman | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 5560 | Scott McTominay | 195851 | Scott McTominay | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 5569 | Rhian Brewster | 195473 | Rhian Brewster | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 5584 | Aaron Wan-Bissaka | 214590 | Aaron Wan-Bissaka | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 5590 | Tosin Adarabioyo | 109646 | Tosin Adarabioyo | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 5595 | Daniel James | 200617 | Daniel James | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 5603 | Aaron Ramsdale | 225321 | Aaron Ramsdale | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 5609 | Yves Bissouma | 227127 | Yves Bissouma | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 5612 | Anwar El Ghazi | 193488 | Anwar El Ghazi | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 5613 | Gabriel | 226597 | Gabriel Magalhães | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 5656 | Nicolas Pepe | 195735 | Nicolas Pépé | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 5681 | Giovani Lo Celso | 200826 | Giovani Lo Celso | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 5708 | Fernando Marçal | 111291 | Fernando Marçal | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 5735 | Jean-Philippe Mateta | 231747 | Jean-Philippe Mateta | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 5956 | Youri Tielemans | 166989 | Youri Tielemans | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 5962 | Tanguy NDombele Alvaro | 231372 | Tanguy Ndombele | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 5973 | Kenny Tete | 167074 | Kenny Tete | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6026 | Richarlison | 212319 | Richarlison de Andrade | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6027 | Jairo Riedewald | 173954 | Jairo Riedewald | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 6042 | Jan Bednarek | 171771 | Jan Bednarek | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 6044 | Charlie Taylor | 103914 | Charlie Taylor | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 6048 | Lewis Dunk | 83299 | Lewis Dunk | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6049 | Solly March | 109345 | Solomon March | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6051 | Dale Stephens | 40845 | Dale Stephens | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 6054 | Ederson | 121160 | Ederson Santana de Moraes | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 6055 | Phil Foden | 209244 | Phil Foden | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6062 | Isaac Hayden | 153127 | Isaac Hayden | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 6063 | Jacob Murphy | 114243 | Jacob Murphy | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6080 | Victor Lindelöf | 184667 | Victor Lindelöf | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6122 | Douglas Luiz | 230046 | Douglas Luiz Soares de Paulo | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6157 | Timothy Castagne | 166477 | Timothy Castagne | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6163 | Nélson Semedo | 200402 | Nélson Cabral Semedo | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 6249 | Davinson Sánchez | 173904 | Davinson Sánchez | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 6273 | Robin Koch | 193645 | Robin Koch | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 6274 | Andriy Yarmolenko | 56377 | Andriy Yarmolenko | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 6314 | Joachim Andersen | 174874 | Joachim Andersen | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6369 | Ethan Ampadu | 199598 | Ethan Ampadu | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6377 | Joe Rodon | 214225 | Joe Rodon | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6382 | Pedro Neto | 247632 | Pedro Lomba Neto | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6418 | Hamza Choudhury | 197469 | Hamza Choudhury | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 6424 | Ben Johnson | 222018 | Ben Johnson | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 6434 | Franck Zambo | 203325 | André-Frank Zambo Anguissa | name-variant | high | 1.04 | team-and-first-name-season-stats-supported |
| 2021 | 6441 | Ferrán Torres | 224444 | Ferran Torres | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 6456 | Callum Hudson-Odoi | 209046 | Callum Hudson-Odoi | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6477 | Cenk Tosun | 66838 | Cenk Tosun | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 6482 | Eddie Nketiah | 205533 | Edward Nketiah | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6492 | Reiss Nelson | 200641 | Reiss Nelson | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6504 | Michael Obafemi | 220598 | Michael Obafemi | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 6521 | Yerry Mina | 164511 | Yerry Mina | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 6532 | Martin Dubravka | 67089 | Martin Dubravka | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6630 | Joe Willock | 200089 | Joseph Willock | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6665 | Curtis Jones | 206915 | Curtis Jones | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6674 | Rayan Ait Nouri | 448514 | Rayan Ait Nouri | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6681 | Harvey Barnes | 201666 | Harvey Barnes | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6736 | Ibrahima Diallo | 240143 | Ibrahima Diallo | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 6756 | Dwight McNeil | 433154 | Dwight McNeil | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6817 | Fred | 101582 | Frederico Rodrigues de Paula Santos | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 6818 | James Maddison | 172780 | James Maddison | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6827 | Bobby Reid | 96994 | Bobby Decordova-Reid | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 6835 | Tom Cairney | 76357 | Tom Cairney | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6840 | Neeskens Kebano | 92259 | Neeskens Kebano | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 6849 | Rui Patrício | 38533 | Rui Pedro dos Santos Patrício | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2021 | 6850 | Willy Boly | 90585 | Willy Boly | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 6851 | Conor Coady | 94147 | Conor Coady | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 6852 | Matt Doherty | 87835 | Matt Doherty | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6853 | Rúben Neves | 171317 | Rúben Diogo da Silva Neves | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 6854 | Diogo Jota | 194634 | Diogo Jota | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 6856 | Rúben Vinagre | 216054 | Rúben Gonçalo Silva Nascimento Vinagre | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 6857 | Morgan Gibbs-White | 222531 | Morgan Gibbs-White | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 6859 | Kortney Hause | 123354 | Kortney Hause | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 6880 | Edouard Mendy | 228286 | Edouard Mendy | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 6891 | Ryan Fredericks | 81012 | Ryan Fredericks | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 6893 | Stuart Armstrong | 91047 | Stuart Armstrong | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 6923 | Mohammed Salisu | 450527 | Mohammed Salisu | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 6962 | Robin Olsen | 111782 | Robin Olsen | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 7063 | Bernard | 100649 | Bernard Anício Caldeira Duarte | name-variant | high | 1.03 | web-name-exact |
| 2021 | 7078 | Sean Longstaff | 180135 | Sean Longstaff | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 7184 | Tim Ream | 82514 | Tim Ream | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 7187 | Sergio Reguilón | 199249 | Sergio Reguilón | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 7230 | Emile Smith-Rowe | 209289 | Emile Smith Rowe | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 7236 | Leander Dendoncker | 151589 | Leander Dendoncker | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 7280 | Yan Valery | 213482 | Yan Valery | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 7298 | Ben White | 198869 | Ben White | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 7322 | Bukayo Saka | 223340 | Bukayo Saka | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 7332 | Max Kilman | 214048 | Max Kilman | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 7376 | Ozan Kabak | 438277 | Ozan Kabak | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 7382 | Dan Burn | 78916 | Dan Burn | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 7395 | Carlos Vinicius | 245824 | Carlos Vinicius Alves Morais | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 7420 | Miguel Almirón | 179018 | Miguel Almirón | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 7490 | Mason Greenwood | 220688 | Mason Greenwood | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 7589 | Wesley Fofana | 444463 | Wesley Fofana | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 7689 | Ben Godfrey | 198826 | Ben Godfrey | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 7691 | Jamal Lewis | 194799 | Jamal Lewis | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 7698 | Leandro Trossard | 116216 | Leandro Trossard | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 7699 | Adam Webster | 110735 | Adam Webster | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 7700 | Che Adams | 200439 | Che Adams | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 7701 | Moussa Djenepo | 431131 | Moussa Djenepo | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 7702 | Dean Henderson | 172649 | Dean Henderson | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 7703 | John Egan | 108416 | John Egan | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 7704 | Chris Basham | 40386 | Chris Basham | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 7706 | George Baldock | 82691 | George Baldock | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 7709 | John Fleck | 47247 | John Fleck | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 7710 | Oliver Norwood | 79934 | Oliver Norwood | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 7714 | Ben Osborn | 167878 | Ben Osborn | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 7722 | Trézéguet | 148508 | Mahmoud Ahmed Ibrahim Hassan | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 7723 | John McGinn | 122806 | John McGinn | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 7724 | Wesley | 213345 | Wesley Moraes | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 7726 | Ezri Konsa Ngoyo | 199798 | Ezri Konsa Ngoyo | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 7752 | Gabriel Martinelli | 444145 | Gabriel Teodoro Martinelli Silva | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 7753 | James Justin | 220627 | James Justin | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 7768 | Mason Mount | 184341 | Mason Mount | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 7817 | Zack Steffen | 164484 | Zack Steffen | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 7904 | Caoimhin Kelleher | 200720 | Caoimhin Kelleher | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 7988 | Billy Gilmour | 243568 | Billy Gilmour | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 7991 | Aaron Connolly | 233425 | Aaron Connolly | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 8020 | Steven Alzate | 235382 | Steven Alzate | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 8026 | Raphinha | 219961 | Raphael Dias Belloli | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 8040 | Marvelous Nakamba | 184704 | Marvelous Nakamba | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 8067 | Reece James | 225796 | Reece James | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 8075 | Brandon Williams | 232937 | Brandon Williams | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 8089 | Kieran Tierney | 192895 | Kieran Tierney | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 8127 | Amad Diallo Traore | 493250 | Amad Diallo | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 8150 | Anthony Gordon | 232826 | Anthony Gordon | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 8204 | Neco Williams | 215136 | Neco Williams | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 8214 | Tyrick Mitchell | 244723 | Tyrick Mitchell | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 8222 | Japhet Tanganga | 199584 | Japhet Tanganga | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 8224 | William Smallbone | 214466 | William Smallbone | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 8226 | Tariq Lamptey | 232792 | Tariq Lamptey | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 8228 | Nathaniel Phillips | 197464 | Nathaniel Phillips | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 8239 | Takumi Minamino | 157882 | Takumi Minamino | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 8285 | Sander Berge | 207189 | Sander Berge | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 8286 | Jack Robinson | 83427 | Jack Robinson | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 8288 | Tomas Soucek | 215439 | Tomas Soucek | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 8291 | Daniel Podence | 200600 | Daniel Castelo Podence | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 8300 | Steven Bergwijn | 194252 | Steven Bergwijn | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 8323 | Josh Brownhill | 172782 | Josh Brownhill | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 8351 | Ki-Jana Hoever | 441271 | Ki-Jana Hoever | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 8379 | Alexis Mac Allister | 243016 | Alexis Mac Allister | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 8380 | Pablo Marí | 92371 | Pablo Marí | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 8456 | Nathan Tella | 203389 | Nathan Tella | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 8562 | Luke Thomas | 244619 | Luke Thomas | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 8704 | Marek Rodák | 155529 | Marek Rodák | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 8706 | Eberechi Eze | 232413 | Eberechi Eze | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 8715 | Illan Meslier | 437495 | Illan Meslier | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 8716 | Luke Ayling | 66588 | Luke Ayling | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 8717 | Pascal Struijk | 222694 | Pascal Struijk | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 8718 | Stuart Dallas | 87873 | Stuart Dallas | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 8719 | Kalvin Phillips | 155405 | Kalvin Phillips | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 8720 | Jack Harrison | 221399 | Jack Harrison | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 8721 | Jamie Shackleton | 221610 | Jamie Shackleton | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 8723 | Ian Poveda-Ocampo | 215460 | Ian Carlo Poveda-Ocampo | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 2021 | 8756 | Dara O&#039;Shea | 216616 | Dara O'Shea | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 8777 | Vitinha | 437858 | Vitor Ferreira | name-variant | high | 1.03 | web-name-exact |
| 2021 | 8778 | Fabio Silva | 449988 | Fabio Silva | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 8780 | Joël Veltman | 111478 | Joël Veltman | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 8816 | Liam Cooper | 55914 | Liam Cooper | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 8821 | Donny van de Beek | 180184 | Donny van de Beek | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 8852 | Konstantinos Tsimikas | 214285 | Konstantinos Tsimikas | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 8864 | Matthew Cash | 199796 | Matthew Cash | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 8865 | Ollie Watkins | 178301 | Ollie Watkins | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 8868 | Liam Delap | 463034 | Liam Delap | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 8905 | Conor Townsend | 108053 | Conor Townsend | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 8918 | Max Lowe | 155197 | Max Lowe | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 8919 | Leif Davis | 455084 | Leif Davis | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 8940 | Antonee Robinson | 169528 | Antonee Robinson | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 8941 | Jacob Ramsey | 232653 | Jacob Ramsey | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 8961 | Rúben Dias | 171314 | Rúben Santos Gato Alves Dias | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 8965 | Vladimir Coufal | 164555 | Vladimir Coufal | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 8992 | Hakim Ziyech | 124183 | Hakim Ziyech | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 9040 | Conor Gallagher | 232787 | Conor Gallagher | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 9098 | Robert Sánchez | 215059 | Robert Sánchez | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 9154 | Elliot Anderson | 215379 | Elliot Anderson | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 9205 | Jayden Bogle | 226182 | Jayden Bogle | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 9222 | Antwoine Hackford | 487836 | Antwoine Hackford | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 9284 | Jakub Moder | 243505 | Jakub Moder | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 9307 | Iliman Ndiaye | 440993 | Iliman Ndiaye | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 9332 | Dane Scarlett | 490145 | Dane Scarlett | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 9356 | Carney Chukwuemeka | 478912 | Carney Chukwuemeka | carried-forward | high | 1 | carried-from-2324 |
| 2021 | 9359 | Shola Shoretire | 472464 | Shola Shoretire | carried-forward | high | 1 | carried-from-2122 |
| 2021 | 9406 | Nathan Broadhead | 173818 | Nathan Broadhead | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 9415 | Jaden Philogene-Bidace | 481624 | Jaden Philogene-Bidace | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 9501 | Fabio Carvalho | 244858 | Fabio Carvalho | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 9509 | Daniel Jebbison | 523700 | Daniel Jebbison | carried-forward | high | 1 | carried-from-2425 |
| 2021 | 9524 | Anthony Elanga | 449434 | Anthony Elanga | carried-forward | high | 1 | carried-from-2526 |
| 2021 | 9552 | Tyrese Francois | 432931 | Tyrese Francois | carried-forward | high | 1 | carried-from-2223 |
| 2021 | 9558 | Hannibal Mejbri | 465527 | Hannibal Mejbri | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 62 | Lukas Rupp | 76306 | Lukas Rupp | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 76 | Fabian Schär | 119471 | Fabian Schär | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 87 | Joelinton | 180974 | Joelinton Cássio Apolinário de Lira | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 101 | Allan Saint-Maximin | 170137 | Allan Saint-Maximin | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 111 | Jannik Vestergaard | 93100 | Jannik Vestergaard | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 181 | Bernd Leno | 80201 | Bernd Leno | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 191 | Chicharito | 43020 | Javier Hernández Balcázar | name-variant | high | 1.03 | web-name-exact |
| 1920 | 200 | Andreas Christensen | 135363 | Andreas Christensen | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 204 | Granit Xhaka | 84450 | Granit Xhaka | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 239 | Pascal Groß | 60307 | Pascal Groß | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 314 | Ilkay Gündogan | 59859 | Ilkay Gündogan | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 318 | Pierre-Emerick Aubameyang | 54694 | Pierre-Emerick Aubameyang | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 332 | Joel Matip | 60914 | Joel Matip | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 342 | Sead Kolasinac | 111457 | Sead Kolasinac | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 343 | Pierre-Emile Højbjerg | 132015 | Pierre-Emile Højbjerg | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 371 | Sokratis | 39476 | Sokratis Papastathopoulos | name-variant | high | 1.03 | web-name-exact |
| 1920 | 447 | Kevin De Bruyne | 61366 | Kevin De Bruyne | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 453 | Son Heung-Min | 85971 | Heung-Min Son | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 458 | Steve Cook | 56917 | Steve Cook | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 461 | Matt Ritchie | 56983 | Matt Ritchie | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 462 | Dan Gosling | 40387 | Dan Gosling | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 463 | Junior Stanislas | 56872 | Junior Stanislas | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 465 | Joshua King | 78007 | Joshua King | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 468 | Callum Wilson | 75115 | Callum Wilson | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 482 | Roberto Firmino | 92217 | Roberto Firmino | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 484 | Divock Origi | 152760 | Divock Origi | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 485 | Mamadou Sakho | 40784 | Mamadou Sakho | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 486 | Adam Lallana | 39155 | Adam Lallana | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 489 | James Milner | 15157 | James Milner | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 492 | Héctor Bellerín | 98745 | Héctor Bellerín | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 500 | Alex Iwobi | 153133 | Alex Iwobi | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 501 | Danny Welbeck | 50175 | Danny Welbeck | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 502 | Olivier Giroud | 44346 | Olivier Giroud | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 503 | Theo Walcott | 20467 | Theo Walcott | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 508 | Calum Chambers | 101184 | Calum Chambers | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 509 | Wayne Hennessey | 20066 | Wayne Hennessey | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 510 | Joel Ward | 55494 | Joel Ward | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 512 | Scott Dann | 19188 | Scott Dann | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 522 | Wilfried Zaha | 82403 | Wilfried Zaha | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 525 | Martin Kelly | 58786 | Martin Kelly | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 527 | Adrián | 60706 | Adrián San Miguel del Castillo | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 528 | Angelo Ogbonna | 40669 | Angelo Ogbonna | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 530 | James Tomkins | 49413 | James Tomkins | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 531 | Michail Antonio | 57531 | Michail Antonio | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 532 | Cheikhou Kouyaté | 55037 | Cheikhou Kouyaté | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 533 | Mark Noble | 18073 | Mark Noble | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 534 | Aaron Cresswell | 55459 | Aaron Cresswell | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 535 | Manuel Lanzini | 86934 | Manuel Lanzini | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 537 | Andy Carroll | 40142 | Andy Carroll | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 540 | Darren Randolph | 32259 | Darren Randolph | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 546 | David de Gea | 51940 | David de Gea | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 549 | Timothy Fosu-Mensah | 201084 | Timothy Fosu-Mensah | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 553 | Anthony Martial | 148225 | Anthony Martial | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 554 | Juan Mata | 43670 | Juan Mata | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 556 | Marcus Rashford | 176297 | Marcus Rashford | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 558 | Jesse Lingard | 109322 | Jesse Lingard | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 573 | Odion Ighalo | 58498 | Odion Ighalo | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 574 | Troy Deeney | 41725 | Troy Deeney | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 579 | Nathan Aké | 126184 | Nathan Aké | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 581 | Craig Cathcart | 41338 | Craig Cathcart | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 585 | Seamus Coleman | 59949 | Seamus Coleman | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 586 | John Stones | 97299 | John Stones | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 587 | Phil Jagielka | 7645 | Phil Jagielka | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 589 | James McCarthy | 50472 | James McCarthy | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 592 | Ross Barkley | 88894 | Ross Barkley | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 593 | Aaron Lennon | 17349 | Aaron Lennon | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 596 | Tom Cleverley | 43250 | Tom Cleverley | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 605 | Jordan Henderson | 56979 | Jordan Henderson | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 606 | Christian Benteke | 54861 | Christian Benteke | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 614 | Fernandinho | 27789 | Fernando Luiz Rosa | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 618 | Raheem Sterling | 103955 | Raheem Sterling | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 619 | Sergio Agüero | 37572 | Sergio Agüero | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 620 | Kelechi Iheanacho | 173515 | Kelechi Iheanacho | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 624 | Willy Caballero | 20310 | Willy Caballero | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 631 | Ashley Young | 18892 | Ashley Young | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 633 | James McArthur | 50471 | James McArthur | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 635 | Alex McCarthy | 58376 | Alex McCarthy | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 637 | Hugo Lloris | 37915 | Hugo Lloris | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 638 | Kyle Walker | 58621 | Kyle Walker | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 639 | Toby Alderweireld | 55605 | Toby Alderweireld | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 641 | Danny Rose | 38290 | Danny Rose | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 643 | Eric Dier | 93264 | Eric Dier | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 644 | Erik Lamela | 62974 | Erik Lamela | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 645 | Dele Alli | 108823 | Bamidele Alli | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 646 | Christian Eriksen | 80607 | Christian Eriksen | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 647 | Harry Kane | 78830 | Harry Kane | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 660 | Ben Davies | 115556 | Ben Davies | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 669 | Ashley Westwood | 60551 | Ashley Westwood | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 672 | Jordan Ayew | 80146 | Jordan Ayew | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 675 | Jack Grealish | 114283 | Jack Grealish | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 681 | César Azpilicueta | 41328 | César Azpilicueta | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 687 | Pedro | 49579 | Pedro Rodríguez Ledesma | name-variant | high | 1.03 | web-name-exact |
| 1920 | 688 | Ruben Loftus-Cheek | 126187 | Ruben Loftus-Cheek | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 697 | Nemanja Matic | 62398 | Nemanja Matic | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 699 | Gary Cahill | 19419 | Gary Cahill | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 700 | Willian | 47431 | Willian Borges Da Silva | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 702 | Tammy Abraham | 173879 | Tammy Abraham | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 703 | Fikayo Tomori | 194794 | Fikayo Tomori | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 706 | Lukasz Fabianski | 37096 | Lukasz Fabianski | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 708 | Federico Fernández | 57145 | Federico Fernández | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 710 | Neil Taylor | 47390 | Neil Taylor | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 712 | Jack Cork | 40145 | Jack Cork | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 714 | Gylfi Sigurdsson | 55422 | Gylfi Sigurdsson | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 723 | Ki Sung-yueng | 76542 | Sung-yueng Ki | name-variant | high | 1.03 | web-name-exact |
| 1920 | 727 | DeAndre Yedlin | 151119 | DeAndre Yedlin | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 730 | Patrick van Aanholt | 74230 | Patrick van Aanholt | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 741 | Jordan Pickford | 111234 | Jordan Pickford | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 743 | Dwight Gayle | 104547 | Dwight Gayle | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 745 | Kasper Schmeichel | 17745 | Kasper Schmeichel | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 748 | Wes Morgan | 15033 | Wes Morgan | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 749 | Christian Fuchs | 37402 | Christian Fuchs | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 750 | Riyad Mahrez | 103025 | Riyad Mahrez | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 751 | N&#039;Golo Kanté | 116594 | N'Golo Kanté | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 753 | Marc Albrighton | 51938 | Marc Albrighton | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 755 | Jamie Vardy | 101668 | Jamie Vardy | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 757 | Jeffrey Schlupp | 86417 | Jeffrey Schlupp | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 762 | Demarai Gray | 172632 | Demarai Gray | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 766 | Jamaal Lascelles | 101148 | Jamaal Lascelles | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 769 | Jonjo Shelvey | 50232 | Jonjo Shelvey | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 770 | Ayoze Pérez | 168580 | Ayoze Pérez | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 771 | Georginio Wijnaldum | 41733 | Georginio Wijnaldum | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 772 | Moussa Sissoko | 45268 | Moussa Sissoko | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 775 | Andros Townsend | 60252 | Andros Townsend | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 782 | Ben Chilwell | 172850 | Benjamin Chilwell | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 789 | Robbie Brady | 90517 | Robbie Brady | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 790 | Nathan Redmond | 83283 | Nathan Redmond | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 803 | Ben Foster | 9089 | Ben Foster | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 804 | Craig Dawson | 60232 | Craig Dawson | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 807 | Jonny Evans | 37642 | Jonny Evans | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 825 | Adam Smith | 54469 | Adam Smith | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 833 | Virgil van Dijk | 97032 | Virgil van Dijk | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 835 | Ryan Bertrand | 40146 | Ryan Bertrand | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 838 | Sadio Mané | 110979 | Sadio Mané | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 839 | Shane Long | 20452 | Shane Long | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 842 | Oriol Romeu | 78056 | Oriol Romeu Vidal | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 843 | James Ward-Prowse | 101178 | James Ward-Prowse | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 844 | Jay Rodriguez | 44683 | Jay Rodriguez | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 847 | Cédric Soares | 58822 | Cédric Soares | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 853 | Paul Dummett | 106618 | Paul Dummett | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 857 | Phil Bardsley | 17997 | Phil Bardsley | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 875 | Ciaran Clark | 58845 | Ciaran Clark | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 876 | Fabian Delph | 41823 | Fabian Delph | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 884 | Matt Targett | 169359 | Matt Targett | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 885 | Kyle Walker-Peters | 158534 | Kyle Walker-Peters | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 887 | Erik Pieters | 39487 | Erik Pieters | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 888 | Xherdan Shaqiri | 68312 | Xherdan Shaqiri | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 900 | Adama Traoré | 159533 | Adama Traoré | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 902 | Sam Byram | 113564 | Sam Byram | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 922 | Andreas Pereira | 156689 | Andreas Pereira | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 925 | Patrick Roberts | 124165 | Patrick Roberts | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 934 | Axel Tuanzebe | 180804 | Axel Tuanzebe | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 935 | Kurt Zouma | 103192 | Kurt Zouma | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 951 | Phil Jones | 76359 | Phil Jones | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 966 | Alex Oxlade-Chamberlain | 81880 | Alex Oxlade-Chamberlain | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 971 | Harry Winks | 157668 | Harry Winks | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 982 | Tim Krul | 20480 | Tim Krul | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 985 | Mason Holgate | 194164 | Mason Holgate | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 986 | Danny Ings | 84939 | Danny Ings | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 987 | Joseph Gomez | 171287 | Joseph Gomez | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 1006 | Luke Shaw | 106760 | Luke Shaw | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 1017 | Matej Vydra | 81183 | Matej Vydra | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 1024 | Tyrone Mings | 149484 | Tyrone Mings | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 1040 | Angelino | 145235 | José Ángel Esmorís Tasende | name-variant | high | 1.03 | web-name-exact |
| 1920 | 1042 | Tom Davies | 173807 | Tom Davies | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 1053 | Keinan Davis | 221239 | Keinan Davis | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 1208 | Felipe Anderson | 101537 | Felipe Anderson Pereira Gomes | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 1228 | Bruno Fernandes | 141746 | Bruno Miguel Borges Fernandes | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 1234 | Dennis Praet | 106837 | Dennis Praet | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 1245 | Emerson | 109533 | Emerson Palmieri dos Santos | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 1250 | Mohamed Salah | 118748 | Mohamed Salah | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 1257 | Alisson | 116535 | Alisson Ramses Becker | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 1304 | Moise Kean | 242058 | Moise Kean | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 1389 | Jorginho | 85955 | Jorge Luiz Frello Filho | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 1441 | Adam Masina | 155651 | Adam Masina | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 1545 | Emil Krafth | 111773 | Emil Krafth | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 1621 | Marcos Alonso | 82263 | Marcos Alonso | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 1652 | Matthew Lowton | 68983 | Matthew Lowton | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 1653 | Michael Keane | 106611 | Michael Keane | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 1654 | Ben Mee | 51927 | Ben Mee | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 1663 | Johann Berg Gudmundsson | 60586 | Johann Berg Gudmundsson | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 1665 | James Tarkowski | 17761 | James Tarkowski | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 1676 | David Luiz | 41270 | David Luiz Moreira Marinho | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 1677 | Nathaniel Chalobah | 89085 | Nathaniel Chalobah | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 1678 | Michy Batshuayi | 94245 | Michy Batshuayi | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 1679 | Dominic Solanke | 154566 | Dominic Solanke | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 1683 | Ryan Fraser | 90105 | Ryan Fraser | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 1685 | Ahmed Elmohamady | 37339 | Ahmed El Mohamady | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 1687 | Harry Maguire | 95658 | Harry Maguire | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 1688 | Andrew Robertson | 122798 | Andrew Robertson | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 1691 | Robert Snodgrass | 18987 | Robert Snodgrass | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 1699 | Shkodran Mustafi | 69140 | Shkodran Mustafi | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 1701 | Borja Bastón | 83091 | Borja González Tomás | name-variant | high | 1.06 | team-and-shared-name-tokens |
| 1920 | 1719 | Javier Manquillo | 109528 | Javier Manquillo | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 1724 | Isaac Success | 173514 | Isaac Success Ajayi | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 1920 | 1725 | Christian Kabasele | 85624 | Christian Kabasele | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 1726 | Abdoulaye Doucouré | 121599 | Abdoulaye Doucouré | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 1735 | Jack Stephens | 88900 | Jack Stephens | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 1736 | Oliver McBurnie | 169432 | Oliver McBurnie | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 1739 | Eric Bailly | 197365 | Eric Bailly | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 1740 | Paul Pogba | 74208 | Paul Pogba | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 1746 | Jeff Hendrick | 83314 | Jeff Hendrick | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 1747 | Kevin Long | 41674 | Kevin Long | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 1748 | Lys Mousset | 178304 | Lys Mousset | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 1749 | Rob Holding | 156074 | Rob Holding | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 1750 | Ainsley Maitland-Niles | 154043 | Ainsley Maitland-Niles | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 1760 | Arthur Masuaku | 105717 | Arthur Masuaku | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 1776 | Jarrod Bowen | 178186 | Jarrod Bowen | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 1785 | Nampalys Mendy | 86881 | Nampalys Mendy | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 1789 | Lewis Cook | 155408 | Lewis Cook | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 1791 | Trent Alexander-Arnold | 169187 | Trent Alexander-Arnold | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 1822 | Antonio Rüdiger | 102380 | Antonio Rüdiger | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 1823 | Lucas Digne | 101188 | Lucas Digne | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 2132 | Jota | 89274 | José Ignacio Peleteiro Romallo | name-variant | high | 1.03 | web-name-exact |
| 1920 | 2182 | Jefferson Lerma | 152551 | Jefferson Lerma | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 2190 | Vicente Guaita | 40836 | Vicente Guaita | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 2203 | Emiliano Buendía | 195546 | Emiliano Buendía | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 2254 | Mateo Kovacic | 91651 | Mateo Kovacic | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 2280 | Jonny | 114128 | Jonathan Castro Otto | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 2335 | Pablo Fornals | 217593 | Pablo Fornals | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 2379 | João Cancelo | 121145 | João Pedro Cavaco Cancelo | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 2383 | André Gomes | 120250 | André Filipe Tavares Gomes | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 2385 | Mat Ryan | 131897 | Mathew Ryan | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 2446 | Dani Ceballos | 182539 | Daniel Ceballos Fernández | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 2496 | Rodri | 220566 | Rodrigo Hernandez | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 2498 | Aymeric Laporte | 146941 | Aymeric Laporte | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 2662 | Christian Pulisic | 176413 | Christian Pulisic | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 2958 | Oleksandr Zinchenko | 206325 | Oleksandr Zinchenko | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 3203 | Issa Diop | 219924 | Issa Diop | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 3277 | Alexandre Lacazette | 59966 | Alexandre Lacazette | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 3293 | Lucas Moura | 95715 | Lucas Rodrigues Moura da Silva | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 3303 | Ricardo Pereira | 111931 | Ricardo Domingos Barbosa Pereira | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 3389 | Benjamin Mendy | 102826 | Benjamin Mendy | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 3420 | Fabinho | 116643 | Fabio Henrique Tavares | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 3422 | João Moutinho | 19624 | João Filipe Iria Santos Moutinho | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 3491 | Romain Saiss | 107613 | Romain Saïss | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 3600 | Serge Aurier | 80226 | Serge Aurier | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 3621 | Neal Maupay | 115382 | Neal Maupay | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 3635 | Bernardo Silva | 165809 | Bernardo Mota Veiga de Carvalho e Silva | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 4105 | Raúl Jiménez | 102057 | Raúl Jiménez | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 4401 | Emiliano Martinez | 98980 | Emiliano Martínez | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 4422 | Ashley Barnes | 44699 | Ashley Barnes | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 4441 | Matthew James | 61604 | Matty James | name-variant | high | 1.047 | team-and-shared-name-tokens |
| 1920 | 4456 | Chris Wood | 60689 | Chris Wood | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 4475 | Jed Steer | 79852 | Jed Steer | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 4476 | Callum Robinson | 171975 | Callum Robinson | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 4764 | Jean-Philippe Gbamin | 160987 | Jean-Philippe Gbamin | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 4918 | Patrick Cutrone | 209353 | Patrick Cutrone | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 5043 | Kiko Femenía | 54484 | Francisco Femenía Far | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 5061 | Kepa | 109745 | Kepa Arrizabalaga | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 5087 | Roberto Jiménez | 40694 | Roberto Jimenez Gago | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 1920 | 5234 | Jesús Vallejo | 178876 | Jesús Vallejo Lázaro | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 1920 | 5245 | Bernardo | 209362 | Bernardo Fernandes da Silva Junior | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 5247 | Naby Keita | 175592 | Naby Keita | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 5261 | Kevin Danso | 135720 | Kevin Danso | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 5264 | Caglar Söyüncü | 218031 | Çaglar Söyüncü | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 5543 | Gabriel Jesus | 205651 | Gabriel Fernando de Jesus | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 5544 | Angus Gunn | 107265 | Angus Gunn | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 5545 | Wilfred Ndidi | 203341 | Wilfred Ndidi | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 5549 | Luka Milivojevic | 66975 | Luka Milivojevic | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 5552 | Nick Pope | 98747 | Nick Pope | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 5553 | Declan Rice | 204480 | Declan Rice | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 5555 | Dominic Calvert-Lewin | 177815 | Dominic Calvert-Lewin | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 5560 | Scott McTominay | 195851 | Scott McTominay | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 5584 | Aaron Wan-Bissaka | 214590 | Aaron Wan-Bissaka | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 5595 | Daniel James | 200617 | Daniel James | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 5596 | Harry Wilson | 153682 | Harry Wilson | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 5598 | Angel Gomes | 209041 | Angel Gomes | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 5602 | Sam Surridge | 217331 | Sam Surridge | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 5603 | Aaron Ramsdale | 225321 | Aaron Ramsdale | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 5609 | Yves Bissouma | 227127 | Yves Bissouma | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 5612 | Anwar El Ghazi | 193488 | Anwar El Ghazi | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 5656 | Nicolas Pepe | 195735 | Nicolas Pépé | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 5675 | Ismaila Sarr | 232185 | Ismaïla Sarr | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 5681 | Giovani Lo Celso | 200826 | Giovani Lo Celso | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 5956 | Youri Tielemans | 166989 | Youri Tielemans | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 5962 | Tanguy NDombele Alvaro | 231372 | Tanguy Ndombele | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 6026 | Richarlison | 212319 | Richarlison de Andrade | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 6027 | Jairo Riedewald | 173954 | Jairo Riedewald | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 6034 | Philip Billing | 168991 | Philip Billing | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 6042 | Jan Bednarek | 171771 | Jan Bednarek | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 6044 | Charlie Taylor | 103914 | Charlie Taylor | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 6047 | Shane Duffy | 61933 | Shane Duffy | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 6048 | Lewis Dunk | 83299 | Lewis Dunk | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 6049 | Solly March | 109345 | Solomon March | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 6050 | Davy Pröpper | 66242 | Davy Pröpper | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 6051 | Dale Stephens | 40845 | Dale Stephens | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 6054 | Ederson | 121160 | Ederson Santana de Moraes | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 6055 | Phil Foden | 209244 | Phil Foden | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 6062 | Isaac Hayden | 153127 | Isaac Hayden | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 6080 | Victor Lindelöf | 184667 | Victor Lindelöf | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 6104 | Will Hughes | 108413 | Will Hughes | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 6122 | Douglas Luiz | 230046 | Douglas Luiz Soares de Paulo | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 6144 | Sébastien Haller | 103123 | Sébastien Haller | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 6249 | Davinson Sánchez | 173904 | Davinson Sánchez | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 6274 | Andriy Yarmolenko | 56377 | Andriy Yarmolenko | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 6336 | Bruno Jordao | 428610 | Bruno André Cavaco Jordao | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 1920 | 6382 | Pedro Neto | 247632 | Pedro Lomba Neto | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 6418 | Hamza Choudhury | 197469 | Hamza Choudhury | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 6424 | Ben Johnson | 222018 | Ben Johnson | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 6456 | Callum Hudson-Odoi | 209046 | Callum Hudson-Odoi | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 6477 | Cenk Tosun | 66838 | Cenk Tosun | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 6482 | Eddie Nketiah | 205533 | Edward Nketiah | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 6492 | Reiss Nelson | 200641 | Reiss Nelson | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 6504 | Michael Obafemi | 220598 | Michael Obafemi | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 6521 | Yerry Mina | 164511 | Yerry Mina | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 6532 | Martin Dubravka | 67089 | Martin Dubravka | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 6542 | Jürgen Locadia | 106757 | Jürgen Locadia | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 6630 | Joe Willock | 200089 | Joseph Willock | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 6665 | Curtis Jones | 206915 | Curtis Jones | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 6681 | Harvey Barnes | 201666 | Harvey Barnes | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 6756 | Dwight McNeil | 433154 | Dwight McNeil | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 6817 | Fred | 101582 | Frederico Rodrigues de Paula Santos | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 6818 | James Maddison | 172780 | James Maddison | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 6820 | David Brooks | 111317 | David Brooks | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 6837 | Ryan Sessegnon | 184349 | Ryan Sessegnon | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 6842 | Alireza Jahanbakhsh | 165210 | Alireza Jahanbakhsh | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 6849 | Rui Patrício | 38533 | Rui Pedro dos Santos Patrício | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 6850 | Willy Boly | 90585 | Willy Boly | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 6851 | Conor Coady | 94147 | Conor Coady | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 6852 | Matt Doherty | 87835 | Matt Doherty | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 6853 | Rúben Neves | 171317 | Rúben Diogo da Silva Neves | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 6854 | Diogo Jota | 194634 | Diogo Jota | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 6856 | Rúben Vinagre | 216054 | Rúben Gonçalo Silva Nascimento Vinagre | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 6857 | Morgan Gibbs-White | 222531 | Morgan Gibbs-White | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 6859 | Kortney Hause | 123354 | Kortney Hause | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 6891 | Ryan Fredericks | 81012 | Ryan Fredericks | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 6892 | Fabián Balbuena | 166640 | Fabián Balbuena | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 6893 | Stuart Armstrong | 91047 | Stuart Armstrong | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 7063 | Bernard | 100649 | Bernard Anício Caldeira Duarte | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 7078 | Sean Longstaff | 180135 | Sean Longstaff | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 7198 | Oliver Skipp | 209042 | Oliver Skipp | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 7230 | Emile Smith-Rowe | 209289 | Emile Smith Rowe | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 7236 | Leander Dendoncker | 151589 | Leander Dendoncker | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 7280 | Yan Valery | 213482 | Yan Valery | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 7281 | Diogo Dalot | 216051 | José Diogo Dalot Teixeira | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 7322 | Bukayo Saka | 223340 | Bukayo Saka | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 7332 | Max Kilman | 214048 | Max Kilman | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 7382 | Dan Burn | 78916 | Dan Burn | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 7384 | Chris Mepham | 223911 | Chris Mepham | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 7420 | Miguel Almirón | 179018 | Miguel Almirón | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 7438 | James Garner | 232928 | James Garner | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 7439 | Tahith Chong | 222677 | Tahith Chong | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 7490 | Mason Greenwood | 220688 | Mason Greenwood | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 7546 | Harvey Elliott | 444884 | Harvey Elliott | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 7582 | Mark Travers | 229600 | Mark Travers | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 7688 | Max Aarons | 232980 | Maximillian Aarons | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 7689 | Ben Godfrey | 198826 | Ben Godfrey | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 7690 | Grant Hanley | 83428 | Grant Hanley | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 7691 | Jamal Lewis | 194799 | Jamal Lewis | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 7693 | Kenny McLean | 78607 | Kenny McLean | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 7695 | Todd Cantwell | 193111 | Todd Cantwell | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 7696 | Teemu Pukki | 57127 | Teemu Pukki | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 7698 | Leandro Trossard | 116216 | Leandro Trossard | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 7699 | Adam Webster | 110735 | Adam Webster | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 7700 | Che Adams | 200439 | Che Adams | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 7701 | Moussa Djenepo | 431131 | Moussa Djenepo | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 7702 | Dean Henderson | 172649 | Dean Henderson | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 7703 | John Egan | 108416 | John Egan | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 7704 | Chris Basham | 40386 | Chris Basham | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 7705 | Jack O&#039;Connell | 146610 | Jack O'Connell | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 7706 | George Baldock | 82691 | George Baldock | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 7707 | Enda Stevens | 63426 | Enda Stevens | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 7708 | John Lundstram | 153723 | John Lundstram | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 7709 | John Fleck | 47247 | John Fleck | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 7710 | Oliver Norwood | 79934 | Oliver Norwood | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 7711 | David McGoldrick | 27436 | David McGoldrick | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 7712 | Billy Sharp | 18867 | Billy Sharp | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 7714 | Ben Osborn | 167878 | Ben Osborn | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 7721 | Conor Hourihane | 85242 | Conor Hourihane | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 7722 | Trézéguet | 148508 | Mahmoud Ahmed Ibrahim Hassan | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 7723 | John McGinn | 122806 | John McGinn | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 7724 | Wesley | 213345 | Wesley Moraes | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 7726 | Ezri Konsa Ngoyo | 199798 | Ezri Konsa Ngoyo | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 7752 | Gabriel Martinelli | 444145 | Gabriel Teodoro Martinelli Silva | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 7753 | James Justin | 220627 | James Justin | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 7768 | Mason Mount | 184341 | Mason Mount | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 7823 | Jack Stacey | 154131 | Jack Stacey | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 7988 | Billy Gilmour | 243568 | Billy Gilmour | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 7990 | Christoph Zimmermann | 192303 | Christoph Zimmermann | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 7991 | Aaron Connolly | 233425 | Aaron Connolly | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 8016 | Matthew Longstaff | 223175 | Matthew Longstaff | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 8020 | Steven Alzate | 235382 | Steven Alzate | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 8021 | Adam Idah | 432735 | Adam Idah | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 8040 | Marvelous Nakamba | 184704 | Marvelous Nakamba | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 8045 | Eric Garcia | 432656 | Eric Garcia | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 8066 | Arnaut Danjuma Groeneveld | 220307 | Arnaut Danjuma Groeneveld | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 8067 | Reece James | 225796 | Reece James | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 8075 | Brandon Williams | 232937 | Brandon Williams | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 8089 | Kieran Tierney | 192895 | Kieran Tierney | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 8090 | Lloyd Kelly | 235530 | Lloyd Kelly | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 8150 | Anthony Gordon | 232826 | Anthony Gordon | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 8204 | Neco Williams | 215136 | Neco Williams | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 8214 | Tyrick Mitchell | 244723 | Tyrick Mitchell | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 8222 | Japhet Tanganga | 199584 | Japhet Tanganga | carried-forward | high | 1 | carried-from-2223 |
| 1920 | 8224 | William Smallbone | 214466 | William Smallbone | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 8226 | Tariq Lamptey | 232792 | Tariq Lamptey | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 8235 | Jeremy Ngakia | 232391 | Jeremy Ngakia | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 8239 | Takumi Minamino | 157882 | Takumi Minamino | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 8257 | Gedson Fernandes | 195774 | Gedson Carvalho Fernandes | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 1920 | 8272 | João Pedro | 475168 | João Pedro Junqueira de Jesus | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 8285 | Sander Berge | 207189 | Sander Berge | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 8286 | Jack Robinson | 83427 | Jack Robinson | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 8288 | Tomas Soucek | 215439 | Tomas Soucek | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 8291 | Daniel Podence | 200600 | Daniel Castelo Podence | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 8300 | Steven Bergwijn | 194252 | Steven Bergwijn | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 8323 | Josh Brownhill | 172782 | Josh Brownhill | carried-forward | high | 1 | carried-from-2324 |
| 1920 | 8379 | Alexis Mac Allister | 243016 | Alexis Mac Allister | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 8380 | Pablo Marí | 92371 | Pablo Marí | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 8384 | Armando Broja | 440323 | Armando Broja | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 8456 | Nathan Tella | 203389 | Nathan Tella | carried-forward | high | 1 | carried-from-2122 |
| 1920 | 8476 | Jarrad Branthwaite | 480455 | Jarrad Branthwaite | carried-forward | high | 1 | carried-from-2526 |
| 1920 | 8493 | Jake Vokins | 214470 | Jake Vokins | carried-forward | high | 1 | carried-from-2021 |
| 1920 | 8496 | Tommy Doyle | 220394 | Tommy Doyle | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 8562 | Luke Thomas | 244619 | Luke Thomas | carried-forward | high | 1 | carried-from-2425 |
| 1920 | 8563 | George Hirst | 222625 | George Hirst | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 47 | Yoshinori Muto | 196118 | Yoshinori Muto | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 76 | Fabian Schär | 119471 | Fabian Schär | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 111 | Jannik Vestergaard | 93100 | Jannik Vestergaard | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 181 | Bernd Leno | 80201 | Bernd Leno | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 191 | Chicharito | 43020 | Javier Hernández Balcázar | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 200 | Andreas Christensen | 135363 | Andreas Christensen | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 204 | Granit Xhaka | 84450 | Granit Xhaka | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 239 | Pascal Groß | 60307 | Pascal Groß | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 314 | Ilkay Gündogan | 59859 | Ilkay Gündogan | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 317 | Henrikh Mkhitaryan | 57249 | Henrikh Mkhitaryan | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 318 | Pierre-Emerick Aubameyang | 54694 | Pierre-Emerick Aubameyang | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 332 | Joel Matip | 60914 | Joel Matip | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 337 | Leroy Sané | 182156 | Leroy Sané | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 338 | Max Meyer | 141020 | Max Meyer | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 342 | Sead Kolasinac | 111457 | Sead Kolasinac | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 343 | Pierre-Emile Højbjerg | 132015 | Pierre-Emile Højbjerg | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 371 | Sokratis | 39476 | Sokratis Papastathopoulos | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 447 | Kevin De Bruyne | 61366 | Kevin De Bruyne | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 453 | Son Heung-Min | 85971 | Heung-Min Son | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 456 | Simon Francis | 15149 | Simon Francis | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 458 | Steve Cook | 56917 | Steve Cook | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 459 | Charlie Daniels | 41320 | Charlie Daniels | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 460 | Andrew Surman | 15237 | Andrew Surman | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 461 | Matt Ritchie | 56983 | Matt Ritchie | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 462 | Dan Gosling | 40387 | Dan Gosling | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 463 | Junior Stanislas | 56872 | Junior Stanislas | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 465 | Joshua King | 78007 | Joshua King | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 468 | Callum Wilson | 75115 | Callum Wilson | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 481 | Jordon Ibe | 103912 | Jordon Ibe | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 482 | Roberto Firmino | 92217 | Roberto Firmino | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 484 | Divock Origi | 152760 | Divock Origi | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 485 | Mamadou Sakho | 40784 | Mamadou Sakho | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 486 | Adam Lallana | 39155 | Adam Lallana | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 489 | James Milner | 15157 | James Milner | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 492 | Héctor Bellerín | 98745 | Héctor Bellerín | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 495 | Nacho Monreal | 38411 | Nacho Monreal | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 496 | Mohamed Elneny | 153256 | Mohamed Elneny | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 499 | Mesut Özil | 37605 | Mesut Özil | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 500 | Alex Iwobi | 153133 | Alex Iwobi | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 501 | Danny Welbeck | 50175 | Danny Welbeck | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 502 | Olivier Giroud | 44346 | Olivier Giroud | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 503 | Theo Walcott | 20467 | Theo Walcott | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 508 | Calum Chambers | 101184 | Calum Chambers | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 509 | Wayne Hennessey | 20066 | Wayne Hennessey | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 510 | Joel Ward | 55494 | Joel Ward | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 512 | Scott Dann | 19188 | Scott Dann | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 519 | Connor Wickham | 59125 | Connor Wickham | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 522 | Wilfried Zaha | 82403 | Wilfried Zaha | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 524 | Adrian Mariappa | 20145 | Adrian Mariappa | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 525 | Martin Kelly | 58786 | Martin Kelly | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 528 | Angelo Ogbonna | 40669 | Angelo Ogbonna | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 530 | James Tomkins | 49413 | James Tomkins | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 531 | Michail Antonio | 57531 | Michail Antonio | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 532 | Cheikhou Kouyaté | 55037 | Cheikhou Kouyaté | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 533 | Mark Noble | 18073 | Mark Noble | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 534 | Aaron Cresswell | 55459 | Aaron Cresswell | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 535 | Manuel Lanzini | 86934 | Manuel Lanzini | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 537 | Andy Carroll | 40142 | Andy Carroll | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 546 | David de Gea | 51940 | David de Gea | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 549 | Timothy Fosu-Mensah | 201084 | Timothy Fosu-Mensah | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 550 | Marcos Rojo | 58893 | Marcos Rojo | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 551 | Morgan Schneiderlin | 42774 | Morgan Schneiderlin | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 553 | Anthony Martial | 148225 | Anthony Martial | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 554 | Juan Mata | 43670 | Juan Mata | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 556 | Marcus Rashford | 176297 | Marcus Rashford | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 558 | Jesse Lingard | 109322 | Jesse Lingard | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 566 | Sebastian Prödl | 41945 | Sebastian Prödl | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 568 | José Holebas | 40868 | José Holebas | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 572 | Etienne Capoue | 38439 | Etienne Capoue | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 574 | Troy Deeney | 41725 | Troy Deeney | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 579 | Nathan Aké | 126184 | Nathan Aké | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 581 | Craig Cathcart | 41338 | Craig Cathcart | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 585 | Seamus Coleman | 59949 | Seamus Coleman | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 586 | John Stones | 97299 | John Stones | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 587 | Phil Jagielka | 7645 | Phil Jagielka | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 588 | Leighton Baines | 12745 | Leighton Baines | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 589 | James McCarthy | 50472 | James McCarthy | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 591 | Gerard Deulofeu | 94924 | Gerard Deulofeu | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 592 | Ross Barkley | 88894 | Ross Barkley | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 593 | Aaron Lennon | 17349 | Aaron Lennon | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 594 | Romelu Lukaku | 66749 | Romelu Lukaku | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 596 | Tom Cleverley | 43250 | Tom Cleverley | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 599 | Oumar Niasse | 113688 | Oumar Niasse | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 602 | Dejan Lovren | 38454 | Dejan Lovren | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 603 | Nathaniel Clyne | 57328 | Nathaniel Clyne | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 605 | Jordan Henderson | 56979 | Jordan Henderson | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 606 | Christian Benteke | 54861 | Christian Benteke | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 610 | Pablo Zabaleta | 20658 | Pablo Zabaleta | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 611 | Nicolás Otamendi | 57410 | Nicolás Otamendi | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 614 | Fernandinho | 27789 | Fernando Luiz Rosa | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 617 | David Silva | 20664 | David Silva | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 618 | Raheem Sterling | 103955 | Raheem Sterling | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 619 | Sergio Agüero | 37572 | Sergio Agüero | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 620 | Kelechi Iheanacho | 173515 | Kelechi Iheanacho | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 624 | Willy Caballero | 20310 | Willy Caballero | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 631 | Ashley Young | 18892 | Ashley Young | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 633 | James McArthur | 50471 | James McArthur | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 635 | Alex McCarthy | 58376 | Alex McCarthy | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 637 | Hugo Lloris | 37915 | Hugo Lloris | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 638 | Kyle Walker | 58621 | Kyle Walker | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 639 | Toby Alderweireld | 55605 | Toby Alderweireld | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 640 | Jan Vertonghen | 39194 | Jan Vertonghen | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 641 | Danny Rose | 38290 | Danny Rose | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 643 | Eric Dier | 93264 | Eric Dier | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 644 | Erik Lamela | 62974 | Erik Lamela | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 645 | Dele Alli | 108823 | Bamidele Alli | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 646 | Christian Eriksen | 80607 | Christian Eriksen | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 647 | Harry Kane | 78830 | Harry Kane | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 652 | Kieran Trippier | 77794 | Kieran Trippier | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 660 | Ben Davies | 115556 | Ben Davies | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 667 | Carlos Sánchez | 42824 | Carlos Sánchez | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 668 | Idrissa Gueye | 80801 | Idrissa Gueye | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 669 | Ashley Westwood | 60551 | Ashley Westwood | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 672 | Jordan Ayew | 80146 | Jordan Ayew | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 681 | César Azpilicueta | 41328 | César Azpilicueta | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 687 | Pedro | 49579 | Pedro Rodríguez Ledesma | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 688 | Ruben Loftus-Cheek | 126187 | Ruben Loftus-Cheek | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 689 | Kenedy | 167767 | Robert Kenedy Nunes do Nascimento | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 694 | Asmir Begovic | 40349 | Asmir Begovic | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 697 | Nemanja Matic | 62398 | Nemanja Matic | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 699 | Gary Cahill | 19419 | Gary Cahill | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 700 | Willian | 47431 | Willian Borges Da Silva | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 706 | Lukasz Fabianski | 37096 | Lukasz Fabianski | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 708 | Federico Fernández | 57145 | Federico Fernández | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 712 | Jack Cork | 40145 | Jack Cork | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 714 | Gylfi Sigurdsson | 55422 | Gylfi Sigurdsson | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 723 | Ki Sung-yueng | 76542 | Sung-yueng Ki | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 727 | DeAndre Yedlin | 151119 | DeAndre Yedlin | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 730 | Patrick van Aanholt | 74230 | Patrick van Aanholt | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 741 | Jordan Pickford | 111234 | Jordan Pickford | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 745 | Kasper Schmeichel | 17745 | Kasper Schmeichel | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 748 | Wes Morgan | 15033 | Wes Morgan | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 749 | Christian Fuchs | 37402 | Christian Fuchs | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 750 | Riyad Mahrez | 103025 | Riyad Mahrez | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 751 | N&#039;Golo Kanté | 116594 | N'Golo Kanté | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 753 | Marc Albrighton | 51938 | Marc Albrighton | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 755 | Jamie Vardy | 101668 | Jamie Vardy | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 757 | Jeffrey Schlupp | 86417 | Jeffrey Schlupp | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 759 | Daniel Amartey | 155569 | Daniel Amartey | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 762 | Demarai Gray | 172632 | Demarai Gray | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 764 | Daryl Janmaat | 52940 | Daryl Janmaat | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 766 | Jamaal Lascelles | 101148 | Jamaal Lascelles | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 769 | Jonjo Shelvey | 50232 | Jonjo Shelvey | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 770 | Ayoze Pérez | 168580 | Ayoze Pérez | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 771 | Georginio Wijnaldum | 41733 | Georginio Wijnaldum | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 772 | Moussa Sissoko | 45268 | Moussa Sissoko | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 773 | Aleksandar Mitrovic | 128389 | Aleksandar Mitrovic | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 775 | Andros Townsend | 60252 | Andros Townsend | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 782 | Ben Chilwell | 172850 | Benjamin Chilwell | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 785 | John Ruddy | 19236 | John Ruddy | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 787 | Ryan Bennett | 41727 | Ryan Bennett | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 789 | Robbie Brady | 90517 | Robbie Brady | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 790 | Nathan Redmond | 83283 | Nathan Redmond | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 803 | Ben Foster | 9089 | Ben Foster | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 807 | Jonny Evans | 37642 | Jonny Evans | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 813 | Salomón Rondón | 57134 | Salomón Rondón | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 825 | Adam Smith | 54469 | Adam Smith | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 831 | Fraser Forster | 40383 | Fraser Forster | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 833 | Virgil van Dijk | 97032 | Virgil van Dijk | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 835 | Ryan Bertrand | 40146 | Ryan Bertrand | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 836 | Victor Wanyama | 54756 | Victor Wanyama | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 838 | Sadio Mané | 110979 | Sadio Mané | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 839 | Shane Long | 20452 | Shane Long | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 842 | Oriol Romeu | 78056 | Oriol Romeu Vidal | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 843 | James Ward-Prowse | 101178 | James Ward-Prowse | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 845 | Maya Yoshida | 80447 | Maya Yoshida | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 847 | Cédric Soares | 58822 | Cédric Soares | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 848 | Charlie Austin | 78356 | Charlie Austin | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 853 | Paul Dummett | 106618 | Paul Dummett | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 857 | Phil Bardsley | 17997 | Phil Bardsley | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 866 | Joselu | 61316 | Jose Luis Mato Sanmartín | name-variant | high | 1.03 | web-name-exact |
| 1819 | 875 | Ciaran Clark | 58845 | Ciaran Clark | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 876 | Fabian Delph | 41823 | Fabian Delph | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 882 | Glenn Murray | 20529 | Glenn Murray | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 884 | Matt Targett | 169359 | Matt Targett | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 885 | Kyle Walker-Peters | 158534 | Kyle Walker-Peters | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 888 | Xherdan Shaqiri | 68312 | Xherdan Shaqiri | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 900 | Adama Traoré | 159533 | Adama Traoré | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 922 | Andreas Pereira | 156689 | Andreas Pereira | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 935 | Kurt Zouma | 103192 | Kurt Zouma | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 951 | Phil Jones | 76359 | Phil Jones | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 966 | Alex Oxlade-Chamberlain | 81880 | Alex Oxlade-Chamberlain | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 971 | Harry Winks | 157668 | Harry Winks | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 973 | Paulo Gazzaniga | 102884 | Paulo Gazzaniga | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 985 | Mason Holgate | 194164 | Mason Holgate | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 986 | Danny Ings | 84939 | Danny Ings | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 987 | Joseph Gomez | 171287 | Joseph Gomez | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 1006 | Luke Shaw | 106760 | Luke Shaw | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 1017 | Matej Vydra | 81183 | Matej Vydra | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 1024 | Tyrone Mings | 149484 | Tyrone Mings | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 1036 | Jack Wilshere | 54102 | Jack Wilshere | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 1042 | Tom Davies | 173807 | Tom Davies | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 1084 | Jonjoe Kenny | 153673 | Jonjoe Kenny | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 1208 | Felipe Anderson | 101537 | Felipe Anderson Pereira Gomes | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 1227 | Lucas Torreira | 198849 | Lucas Torreira | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 1245 | Emerson | 109533 | Emerson Palmieri dos Santos | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 1250 | Mohamed Salah | 118748 | Mohamed Salah | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 1257 | Alisson | 116535 | Alisson Ramses Becker | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 1299 | Mario Lemina | 151086 | Mario Lemina | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 1389 | Jorginho | 85955 | Jorge Luiz Frello Filho | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 1441 | Adam Masina | 155651 | Adam Masina | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 1621 | Marcos Alonso | 82263 | Marcos Alonso | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 1651 | Tom Heaton | 21205 | Tom Heaton | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 1652 | Matthew Lowton | 68983 | Matthew Lowton | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 1653 | Michael Keane | 106611 | Michael Keane | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 1654 | Ben Mee | 51927 | Ben Mee | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 1660 | Andre Gray | 73426 | Andre Gray | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 1663 | Johann Berg Gudmundsson | 60586 | Johann Berg Gudmundsson | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 1665 | James Tarkowski | 17761 | James Tarkowski | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 1676 | David Luiz | 41270 | David Luiz Moreira Marinho | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 1677 | Nathaniel Chalobah | 89085 | Nathaniel Chalobah | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 1678 | Michy Batshuayi | 94245 | Michy Batshuayi | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 1679 | Dominic Solanke | 154566 | Dominic Solanke | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 1683 | Ryan Fraser | 90105 | Ryan Fraser | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 1687 | Harry Maguire | 95658 | Harry Maguire | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 1688 | Andrew Robertson | 122798 | Andrew Robertson | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 1691 | Robert Snodgrass | 18987 | Robert Snodgrass | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 1699 | Shkodran Mustafi | 69140 | Shkodran Mustafi | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 1707 | Ben Gibson | 83312 | Ben Gibson | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 1719 | Javier Manquillo | 109528 | Javier Manquillo | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 1723 | Roberto Pereyra | 61566 | Roberto Pereyra | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 1724 | Isaac Success | 173514 | Isaac Success Ajayi | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 1725 | Christian Kabasele | 85624 | Christian Kabasele | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 1726 | Abdoulaye Doucouré | 121599 | Abdoulaye Doucouré | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 1729 | Georges-Kévin Nkoudou | 168566 | Georges-Kévin Nkoudou | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 1735 | Jack Stephens | 88900 | Jack Stephens | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 1739 | Eric Bailly | 197365 | Eric Bailly | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 1740 | Paul Pogba | 74208 | Paul Pogba | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 1746 | Jeff Hendrick | 83314 | Jeff Hendrick | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 1747 | Kevin Long | 41674 | Kevin Long | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 1748 | Lys Mousset | 178304 | Lys Mousset | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 1749 | Rob Holding | 156074 | Rob Holding | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 1750 | Ainsley Maitland-Niles | 154043 | Ainsley Maitland-Niles | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 1760 | Arthur Masuaku | 105717 | Arthur Masuaku | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 1785 | Nampalys Mendy | 86881 | Nampalys Mendy | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 1789 | Lewis Cook | 155408 | Lewis Cook | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 1791 | Trent Alexander-Arnold | 169187 | Trent Alexander-Arnold | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 1822 | Antonio Rüdiger | 102380 | Antonio Rüdiger | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 1823 | Lucas Digne | 101188 | Lucas Digne | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 1950 | Martín Montoya | 86153 | Martín Montoya | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 2182 | Jefferson Lerma | 152551 | Jefferson Lerma | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 2190 | Vicente Guaita | 40836 | Vicente Guaita | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 2244 | Danilo | 100180 | Danilo Luiz da Silva | name-variant | high | 1.03 | web-name-exact |
| 1819 | 2254 | Mateo Kovacic | 91651 | Mateo Kovacic | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 2280 | Jonny | 114128 | Jonathan Castro Otto | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 2344 | Christian Atsu | 104953 | Christian Atsu | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 2383 | André Gomes | 120250 | André Filipe Tavares Gomes | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 2385 | Mat Ryan | 131897 | Mathew Ryan | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 2390 | Víctor Camarasa | 175946 | Víctor Camarasa | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 2498 | Aymeric Laporte | 146941 | Aymeric Laporte | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 2587 | Fabri | 40559 | Fabricio Agosto Ramírez | name-variant | high | 1.03 | web-name-exact |
| 1819 | 2958 | Oleksandr Zinchenko | 206325 | Oleksandr Zinchenko | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 3203 | Issa Diop | 219924 | Issa Diop | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 3277 | Alexandre Lacazette | 59966 | Alexandre Lacazette | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 3293 | Lucas Moura | 95715 | Lucas Rodrigues Moura da Silva | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 3303 | Ricardo Pereira | 111931 | Ricardo Domingos Barbosa Pereira | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 3304 | Maxime Le Marchand | 61739 | Maxime Le Marchand | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 3389 | Benjamin Mendy | 102826 | Benjamin Mendy | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 3420 | Fabinho | 116643 | Fabio Henrique Tavares | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 3422 | João Moutinho | 19624 | João Filipe Iria Santos Moutinho | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 3428 | Hélder Costa | 165808 | Hélder Costa | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 3468 | Jonas Lössl | 57513 | Jonas Lössl | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 3491 | Romain Saiss | 107613 | Romain Saïss | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 3600 | Serge Aurier | 80226 | Serge Aurier | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 3635 | Bernardo Silva | 165809 | Bernardo Mota Veiga de Carvalho e Silva | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 3683 | Ivan Cavaleiro | 166324 | Ivan Cavaleiro | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 4068 | Florin Andone | 93284 | Florin Andone | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 4105 | Raúl Jiménez | 102057 | Raúl Jiménez | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 4395 | Junior Hoilett | 49806 | David Junior Hoilett | name-variant | high | 1.035 | team-and-shared-name-tokens |
| 1819 | 4422 | Ashley Barnes | 44699 | Ashley Barnes | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 4456 | Chris Wood | 60689 | Chris Wood | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 4467 | Jazz Richards | 73459 | Ashley Darel Jazz Richards | name-variant | high | 1.03 | web-name-exact |
| 1819 | 4866 | Aboubakar Kamara | 197030 | Aboubakar Kamara | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 5043 | Kiko Femenía | 54484 | Francisco Femenía Far | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 5061 | Kepa | 109745 | Kepa Arrizabalaga | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 5065 | Diego Rico | 171129 | Diego Rico | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 5073 | Florian Lejeune | 77359 | Florian Lejeune | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 5245 | Bernardo | 209362 | Bernardo Fernandes da Silva Junior | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 5247 | Naby Keita | 175592 | Naby Keita | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 5264 | Caglar Söyüncü | 218031 | Çaglar Söyüncü | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 5543 | Gabriel Jesus | 205651 | Gabriel Fernando de Jesus | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 5544 | Angus Gunn | 107265 | Angus Gunn | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 5545 | Wilfred Ndidi | 203341 | Wilfred Ndidi | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 5549 | Luka Milivojevic | 66975 | Luka Milivojevic | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 5553 | Declan Rice | 204480 | Declan Rice | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 5555 | Dominic Calvert-Lewin | 177815 | Dominic Calvert-Lewin | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 5556 | Ademola Lookman | 219352 | Ademola Lookman | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 5560 | Scott McTominay | 195851 | Scott McTominay | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 5565 | Josh Sims | 153379 | Joshua Sims | name-variant | high | 1.05 | team-and-shared-name-tokens |
| 1819 | 5573 | Domingos Quina | 216058 | Domingos Quina | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 5584 | Aaron Wan-Bissaka | 214590 | Aaron Wan-Bissaka | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 5598 | Angel Gomes | 209041 | Angel Gomes | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 5602 | Sam Surridge | 217331 | Sam Surridge | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 5609 | Yves Bissouma | 227127 | Yves Bissouma | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 5759 | Matteo Guendouzi | 242166 | Matteo Guendouzi | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 5956 | Youri Tielemans | 166989 | Youri Tielemans | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 6026 | Richarlison | 212319 | Richarlison de Andrade | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 6030 | Zanka | 48760 | Mathias Jorgensen | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 6033 | Aaron Mooy | 74471 | Aaron Mooy | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 6034 | Philip Billing | 168991 | Philip Billing | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 6042 | Jan Bednarek | 171771 | Jan Bednarek | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 6044 | Charlie Taylor | 103914 | Charlie Taylor | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 6046 | Bruno | 11352 | Bruno Saltor Grau | name-variant | high | 1.03 | web-name-exact |
| 1819 | 6047 | Shane Duffy | 61933 | Shane Duffy | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 6048 | Lewis Dunk | 83299 | Lewis Dunk | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 6049 | Solly March | 109345 | Solomon March | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 6050 | Davy Pröpper | 66242 | Davy Pröpper | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 6051 | Dale Stephens | 40845 | Dale Stephens | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 6054 | Ederson | 121160 | Ederson Santana de Moraes | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 6055 | Phil Foden | 209244 | Phil Foden | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 6062 | Isaac Hayden | 153127 | Isaac Hayden | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 6063 | Jacob Murphy | 114243 | Jacob Murphy | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 6067 | Terence Kongolo | 109434 | Terence Kongolo | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 6080 | Victor Lindelöf | 184667 | Victor Lindelöf | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 6104 | Will Hughes | 108413 | Will Hughes | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 6105 | Gaëtan Bong | 42748 | Gaëtan Bong | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 6231 | José Izquierdo | 167473 | José Heriberto Izquierdo Mena | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 6249 | Davinson Sánchez | 173904 | Davinson Sánchez | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 6274 | Andriy Yarmolenko | 56377 | Andriy Yarmolenko | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 6306 | Juan Foyth | 234908 | Juan Foyth | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 6410 | Jack Simpson | 222434 | Jack Simpson | carried-forward | high | 1 | carried-from-1920 |
| 1819 | 6418 | Hamza Choudhury | 197469 | Hamza Choudhury | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 6424 | Ben Johnson | 222018 | Ben Johnson | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 6434 | Franck Zambo | 203325 | André-Frank Zambo Anguissa | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 6456 | Callum Hudson-Odoi | 209046 | Callum Hudson-Odoi | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 6464 | Adrien Silva | 46483 | Adrien Sebastian Perruchet Silva | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 1819 | 6477 | Cenk Tosun | 66838 | Cenk Tosun | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 6482 | Eddie Nketiah | 205533 | Edward Nketiah | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 6504 | Michael Obafemi | 220598 | Michael Obafemi | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 6521 | Yerry Mina | 164511 | Yerry Mina | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 6532 | Martin Dubravka | 67089 | Martin Dubravka | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 6542 | Jürgen Locadia | 106757 | Jürgen Locadia | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 6630 | Joe Willock | 200089 | Joseph Willock | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 6651 | Grady Diangana | 179830 | Grady Diangana | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 6681 | Harvey Barnes | 201666 | Harvey Barnes | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 6722 | Konstantinos Mavropanos | 233963 | Konstantinos Mavropanos | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 6756 | Dwight McNeil | 433154 | Dwight McNeil | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 6817 | Fred | 101582 | Frederico Rodrigues de Paula Santos | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 6818 | James Maddison | 172780 | James Maddison | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 6820 | David Brooks | 111317 | David Brooks | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 6822 | Lee Peltier | 38716 | Lee Peltier | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 6827 | Bobby Reid | 96994 | Bobby Reid | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 6831 | Greg Cunningham | 80792 | Greg Cunninghamm | name-variant | high | 1.06 | team-and-shared-name-tokens |
| 1819 | 6834 | Joe Bryan | 101105 | Joe Bryan | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 6835 | Tom Cairney | 76357 | Tom Cairney | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 6837 | Ryan Sessegnon | 184349 | Ryan Sessegnon | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 6840 | Neeskens Kebano | 92259 | Neeskens Kebano | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 6841 | Ken Sema | 157775 | Ken Sema | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 6842 | Alireza Jahanbakhsh | 165210 | Alireza Jahanbakhsh | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 6843 | David Button | 50093 | David Button | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 6849 | Rui Patrício | 38533 | Rui Pedro dos Santos Patrício | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 6850 | Willy Boly | 90585 | Willy Boly | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 6851 | Conor Coady | 94147 | Conor Coady | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 6852 | Matt Doherty | 87835 | Matt Doherty | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 6853 | Rúben Neves | 171317 | Rúben Diogo da Silva Neves | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 6854 | Diogo Jota | 194634 | Diogo Jota | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 6855 | Léo Bonatini | 141569 | Bonatini Lohner Maia Bonatini | name-variant | high | 1.03 | team-and-shared-name-tokens |
| 1819 | 6856 | Rúben Vinagre | 216054 | Rúben Gonçalo Silva Nascimento Vinagre | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 6857 | Morgan Gibbs-White | 222531 | Morgan Gibbs-White | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 6891 | Ryan Fredericks | 81012 | Ryan Fredericks | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 6892 | Fabián Balbuena | 166640 | Fabián Balbuena | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 6893 | Stuart Armstrong | 91047 | Stuart Armstrong | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 6894 | Mohamed Elyounoussi | 96787 | Mohamed Elyounoussi | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 7063 | Bernard | 100649 | Bernard Anício Caldeira Duarte | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 7077 | Denis Odoi | 72681 | Denis Odoi | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 7078 | Sean Longstaff | 180135 | Sean Longstaff | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 7184 | Tim Ream | 82514 | Tim Ream | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 7198 | Oliver Skipp | 209042 | Oliver Skipp | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 7236 | Leander Dendoncker | 151589 | Leander Dendoncker | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 7280 | Yan Valery | 213482 | Yan Valery | carried-forward | high | 1 | carried-from-2223 |
| 1819 | 7281 | Diogo Dalot | 216051 | José Diogo Dalot Teixeira | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 7312 | Xande Silva | 209925 | Alexandre Nascimento Costa Silva | name-variant | high | 1.03 | web-name-exact |
| 1819 | 7322 | Bukayo Saka | 223340 | Bukayo Saka | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 7326 | Kayne Ramsay | 232797 | Kayne Ramsay | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 7332 | Max Kilman | 214048 | Max Kilman | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 7384 | Chris Mepham | 223911 | Chris Mepham | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 7390 | Karlan Grant | 180294 | Karlan Grant | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 7420 | Miguel Almirón | 179018 | Miguel Almirón | carried-forward | high | 1 | carried-from-2425 |
| 1819 | 7438 | James Garner | 232928 | James Garner | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 7439 | Tahith Chong | 222677 | Tahith Chong | carried-forward | high | 1 | carried-from-2324 |
| 1819 | 7458 | Matty Daly | 450314 | Matthew Daly | name-variant | high | 1.047 | team-and-shared-name-tokens |
| 1819 | 7459 | Will Norris | 168399 | Will Norris | carried-forward | high | 1 | carried-from-2021 |
| 1819 | 7490 | Mason Greenwood | 220688 | Mason Greenwood | carried-forward | high | 1 | carried-from-2122 |
| 1819 | 7546 | Harvey Elliott | 444884 | Harvey Elliott | carried-forward | high | 1 | carried-from-2526 |
| 1819 | 7582 | Mark Travers | 229600 | Mark Travers | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 37 | Loris Karius | 104542 | Loris Karius | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 191 | Chicharito | 43020 | Javier Hernández Balcázar | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 200 | Andreas Christensen | 135363 | Andreas Christensen | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 204 | Granit Xhaka | 84450 | Granit Xhaka | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 239 | Pascal Groß | 60307 | Pascal Groß | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 248 | Elias Kachunga | 87428 | Elias Kachunga | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 314 | Ilkay Gündogan | 59859 | Ilkay Gündogan | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 317 | Henrikh Mkhitaryan | 57249 | Henrikh Mkhitaryan | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 318 | Pierre-Emerick Aubameyang | 54694 | Pierre-Emerick Aubameyang | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 332 | Joel Matip | 60914 | Joel Matip | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 337 | Leroy Sané | 182156 | Leroy Sané | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 342 | Sead Kolasinac | 111457 | Sead Kolasinac | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 343 | Pierre-Emile Højbjerg | 132015 | Pierre-Emile Højbjerg | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 447 | Kevin De Bruyne | 61366 | Kevin De Bruyne | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 453 | Son Heung-Min | 85971 | Heung-Min Son | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 456 | Simon Francis | 15149 | Simon Francis | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 458 | Steve Cook | 56917 | Steve Cook | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 459 | Charlie Daniels | 41320 | Charlie Daniels | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 460 | Andrew Surman | 15237 | Andrew Surman | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 461 | Matt Ritchie | 56983 | Matt Ritchie | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 462 | Dan Gosling | 40387 | Dan Gosling | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 463 | Junior Stanislas | 56872 | Junior Stanislas | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 465 | Joshua King | 78007 | Joshua King | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 468 | Callum Wilson | 75115 | Callum Wilson | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 481 | Jordon Ibe | 103912 | Jordon Ibe | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 482 | Roberto Firmino | 92217 | Roberto Firmino | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 483 | Daniel Sturridge | 40755 | Daniel Sturridge | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 484 | Divock Origi | 152760 | Divock Origi | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 485 | Mamadou Sakho | 40784 | Mamadou Sakho | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 486 | Adam Lallana | 39155 | Adam Lallana | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 488 | Philippe Coutinho | 84583 | Philippe Coutinho | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 489 | James Milner | 15157 | James Milner | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 491 | Petr Cech | 11334 | Petr Cech | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 492 | Héctor Bellerín | 98745 | Héctor Bellerín | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 494 | Laurent Koscielny | 51507 | Laurent Koscielny | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 495 | Nacho Monreal | 38411 | Nacho Monreal | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 496 | Mohamed Elneny | 153256 | Mohamed Elneny | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 498 | Alexis Sánchez | 37265 | Alexis Sánchez | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 499 | Mesut Özil | 37605 | Mesut Özil | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 500 | Alex Iwobi | 153133 | Alex Iwobi | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 501 | Danny Welbeck | 50175 | Danny Welbeck | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 502 | Olivier Giroud | 44346 | Olivier Giroud | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 503 | Theo Walcott | 20467 | Theo Walcott | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 504 | Aaron Ramsey | 41792 | Aaron Ramsey | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 508 | Calum Chambers | 101184 | Calum Chambers | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 509 | Wayne Hennessey | 20066 | Wayne Hennessey | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 510 | Joel Ward | 55494 | Joel Ward | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 512 | Scott Dann | 19188 | Scott Dann | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 513 | Pape Souaré | 79228 | Pape Souaré | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 514 | Jason Puncheon | 19197 | Jason Puncheon | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 520 | Bakary Sako | 44343 | Bakary Sako | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 522 | Wilfried Zaha | 82403 | Wilfried Zaha | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 523 | Julian Speroni | 11554 | Julian Speroni | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 524 | Adrian Mariappa | 20145 | Adrian Mariappa | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 525 | Martin Kelly | 58786 | Martin Kelly | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 526 | Lee Chung-yong | 75773 | Chung-yong Lee | name-variant | high | 0.99 | web-name-exact |
| 1718 | 527 | Adrián | 60706 | Adrián San Miguel del Castillo | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 528 | Angelo Ogbonna | 40669 | Angelo Ogbonna | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 530 | James Tomkins | 49413 | James Tomkins | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 531 | Michail Antonio | 57531 | Michail Antonio | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 532 | Cheikhou Kouyaté | 55037 | Cheikhou Kouyaté | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 533 | Mark Noble | 18073 | Mark Noble | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 534 | Aaron Cresswell | 55459 | Aaron Cresswell | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 535 | Manuel Lanzini | 86934 | Manuel Lanzini | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 537 | Andy Carroll | 40142 | Andy Carroll | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 541 | Victor Moses | 49013 | Victor Moses | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 542 | Pedro Obiang | 59779 | Pedro Obiang | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 545 | Kieran Gibbs | 42427 | Kieran Gibbs | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 546 | David de Gea | 51940 | David De Gea | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 549 | Timothy Fosu-Mensah | 201084 | Timothy Fosu-Mensah | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 550 | Marcos Rojo | 58893 | Marcos Rojo | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 551 | Morgan Schneiderlin | 42774 | Morgan Schneiderlin | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 552 | Ander Herrera | 59846 | Ander Herrera | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 553 | Anthony Martial | 148225 | Anthony Martial | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 554 | Juan Mata | 43670 | Juan Mata | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 556 | Marcus Rashford | 176297 | Marcus Rashford | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 557 | Matteo Darmian | 40002 | Matteo Darmian | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 558 | Jesse Lingard | 109322 | Jesse Lingard | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 565 | Nyom | 67527 | Allan-Roméo Nyom | name-variant | high | 1.03 | web-name-exact |
| 1718 | 566 | Sebastian Prödl | 41945 | Sebastian Prödl | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 567 | Miguel Britos | 52153 | Miguel Britos | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 568 | José Holebas | 40868 | José Holebas | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 572 | Etienne Capoue | 38439 | Etienne Capoue | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 574 | Troy Deeney | 41725 | Troy Deeney | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 579 | Nathan Aké | 126184 | Nathan Aké | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 581 | Craig Cathcart | 41338 | Craig Cathcart | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 585 | Seamus Coleman | 59949 | Seamus Coleman | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 586 | John Stones | 97299 | John Stones | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 587 | Phil Jagielka | 7645 | Phil Jagielka | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 588 | Leighton Baines | 12745 | Leighton Baines | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 589 | James McCarthy | 50472 | James McCarthy | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 591 | Gerard Deulofeu | 94924 | Gerard Deulofeu | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 592 | Ross Barkley | 88894 | Ross Barkley | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 593 | Aaron Lennon | 17349 | Aaron Lennon | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 594 | Romelu Lukaku | 66749 | Romelu Lukaku | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 596 | Tom Cleverley | 43250 | Tom Cleverley | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 599 | Oumar Niasse | 113688 | Oumar Niasse | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 602 | Dejan Lovren | 38454 | Dejan Lovren | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 603 | Nathaniel Clyne | 57328 | Nathaniel Clyne | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 605 | Jordan Henderson | 56979 | Jordan Henderson | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 606 | Christian Benteke | 54861 | Christian Benteke | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 608 | Alberto Moreno | 100059 | Alberto Moreno | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 609 | Joe Hart | 15749 | Joe Hart | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 610 | Pablo Zabaleta | 20658 | Pablo Zabaleta | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 611 | Nicolás Otamendi | 57410 | Nicolás Otamendi | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 612 | Vincent Kompany | 17476 | Vincent Kompany | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 614 | Fernandinho | 27789 | Fernando Luiz Rosa | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 617 | David Silva | 20664 | David Silva | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 618 | Raheem Sterling | 103955 | Raheem Sterling | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 619 | Sergio Agüero | 37572 | Sergio Agüero | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 620 | Kelechi Iheanacho | 173515 | Kelechi Iheanacho | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 624 | Willy Caballero | 20310 | Willy Caballero | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 627 | Antonio Valencia | 20695 | Antonio Valencia | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 628 | Chris Smalling | 55909 | Chris Smalling | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 630 | Marouane Fellaini | 41184 | Marouane Fellaini | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 631 | Ashley Young | 18892 | Ashley Young | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 633 | James McArthur | 50471 | James McArthur | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 635 | Alex McCarthy | 58376 | Alex McCarthy | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 637 | Hugo Lloris | 37915 | Hugo Lloris | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 638 | Kyle Walker | 58621 | Kyle Walker | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 639 | Toby Alderweireld | 55605 | Toby Alderweireld | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 640 | Jan Vertonghen | 39194 | Jan Vertonghen | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 641 | Danny Rose | 38290 | Danny Rose | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 642 | Mousa Dembélé | 39104 | Mousa Dembélé | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 643 | Eric Dier | 93264 | Eric Dier | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 644 | Erik Lamela | 62974 | Erik Lamela | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 645 | Dele Alli | 108823 | Bamidele Alli | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 646 | Christian Eriksen | 80607 | Christian Eriksen | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 647 | Harry Kane | 78830 | Harry Kane | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 651 | Michel Vorm | 39215 | Michel Vorm | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 652 | Kieran Trippier | 77794 | Kieran Trippier | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 660 | Ben Davies | 115556 | Ben Davies | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 668 | Idrissa Gueye | 80801 | Idrissa Gueye | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 669 | Ashley Westwood | 60551 | Ashley Westwood | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 672 | Jordan Ayew | 80146 | Jordan Ayew | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 681 | César Azpilicueta | 41328 | César Azpilicueta | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 686 | Cesc Fàbregas | 17878 | Cesc Fàbregas | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 687 | Pedro | 49579 | Pedro Rodríguez Ledesma | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 688 | Ruben Loftus-Cheek | 126187 | Ruben Loftus-Cheek | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 689 | Kenedy | 167767 | Robert Kenedy Nunes do Nascimento | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 694 | Asmir Begovic | 40349 | Asmir Begovic | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 697 | Nemanja Matic | 62398 | Nemanja Matic | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 699 | Gary Cahill | 19419 | Gary Cahill | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 700 | Willian | 47431 | Willian Borges Da Silva | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 701 | Eden Hazard | 42786 | Eden Hazard | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 702 | Tammy Abraham | 173879 | Tammy Abraham | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 706 | Lukasz Fabianski | 37096 | Lukasz Fabianski | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 708 | Federico Fernández | 57145 | Federico Fernández | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 712 | Jack Cork | 40145 | Jack Cork | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 713 | André Ayew | 45124 | André Ayew | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 714 | Gylfi Sigurdsson | 55422 | Gylfi Sigurdsson | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 723 | Ki Sung-yueng | 76542 | Sung-yueng Ki | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 727 | DeAndre Yedlin | 151119 | DeAndre Yedlin | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 730 | Patrick van Aanholt | 74230 | Patrick van Aanholt | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 735 | Jermain Defoe | 7958 | Jermain Defoe | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 741 | Jordan Pickford | 111234 | Jordan Pickford | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 743 | Dwight Gayle | 104547 | Dwight Gayle | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 745 | Kasper Schmeichel | 17745 | Kasper Schmeichel | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 746 | Danny Simpson | 40725 | Danny Simpson | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 748 | Wes Morgan | 15033 | Wes Morgan | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 749 | Christian Fuchs | 37402 | Christian Fuchs | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 750 | Riyad Mahrez | 103025 | Riyad Mahrez | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 751 | N&#039;Golo Kanté | 116594 | N'Golo Kanté | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 752 | Daniel Drinkwater | 61603 | Daniel Drinkwater | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 753 | Marc Albrighton | 51938 | Marc Albrighton | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 754 | Shinji Okazaki | 78412 | Shinji Okazaki | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 755 | Jamie Vardy | 101668 | Jamie Vardy | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 757 | Jeffrey Schlupp | 86417 | Jeffrey Schlupp | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 759 | Daniel Amartey | 155569 | Daniel Amartey | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 762 | Demarai Gray | 172632 | Demarai Gray | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 764 | Daryl Janmaat | 52940 | Daryl Janmaat | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 766 | Jamaal Lascelles | 101148 | Jamaal Lascelles | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 769 | Jonjo Shelvey | 50232 | Jonjo Shelvey | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 770 | Ayoze Pérez | 168580 | Ayoze Pérez | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 771 | Georginio Wijnaldum | 41733 | Georginio Wijnaldum | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 772 | Moussa Sissoko | 45268 | Moussa Sissoko | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 773 | Aleksandar Mitrovic | 128389 | Aleksandar Mitrovic | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 775 | Andros Townsend | 60252 | Andros Townsend | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 780 | Karl Darlow | 59735 | Karl Darlow | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 782 | Ben Chilwell | 172850 | Benjamin Chilwell | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 789 | Robbie Brady | 90517 | Robbie Brady | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 790 | Nathan Redmond | 83283 | Nathan Redmond | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 803 | Ben Foster | 9089 | Ben Foster | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 804 | Craig Dawson | 60232 | Craig Dawson | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 807 | Jonny Evans | 37642 | Jonny Evans | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 813 | Salomón Rondón | 57134 | Salomón Rondón | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 815 | Alex Pritchard | 106450 | Alex Pritchard | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 825 | Adam Smith | 54469 | Adam Smith | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 831 | Fraser Forster | 40383 | Fraser Forster | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 833 | Virgil van Dijk | 97032 | Virgil van Dijk | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 835 | Ryan Bertrand | 40146 | Ryan Bertrand | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 836 | Victor Wanyama | 54756 | Victor Wanyama | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 838 | Sadio Mané | 110979 | Sadio Mané | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 839 | Shane Long | 20452 | Shane Long | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 842 | Oriol Romeu | 78056 | Oriol Romeu Vidal | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 843 | James Ward-Prowse | 101178 | James Ward-Prowse | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 844 | Jay Rodriguez | 44683 | Jay Rodriguez | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 845 | Maya Yoshida | 80447 | Maya Yoshida | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 847 | Cédric Soares | 58822 | Cédric Soares | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 848 | Charlie Austin | 78356 | Charlie Austin | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 853 | Paul Dummett | 106618 | Paul Dummett | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 856 | Jack Butland | 105666 | Jack Butland | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 857 | Phil Bardsley | 17997 | Phil Bardsley | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 865 | Marko Arnautovic | 41464 | Marko Arnautovic | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 866 | Joselu | 61316 | Jose Luis Mato Sanmartín | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 871 | Bojan | 40276 | Bojan Krkic Perez | name-variant | high | 1.025 | web-name-exact |
| 1718 | 872 | Peter Crouch | 3773 | Peter Crouch | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 875 | Ciaran Clark | 58845 | Ciaran Clark | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 876 | Fabian Delph | 41823 | Fabian Delph | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 878 | Yaya Touré | 14664 | Gnegneri Yaya Touré | name-variant | high | 1.03 | web-name-exact |
| 1718 | 881 | Harry Arter | 48615 | Harry Arter | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 882 | Glenn Murray | 20529 | Glenn Murray | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 883 | Steven Davis | 17339 | Steven Davis | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 884 | Matt Targett | 169359 | Matt Targett | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 885 | Kyle Walker-Peters | 158534 | Kyle Walker-Peters | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 887 | Erik Pieters | 39487 | Erik Pieters | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 888 | Xherdan Shaqiri | 68312 | Xherdan Shaqiri | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 902 | Sam Byram | 113564 | Sam Byram | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 908 | Muhamed Besic | 87447 | Muhamed Besic | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 934 | Axel Tuanzebe | 180804 | Axel Tuanzebe | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 935 | Kurt Zouma | 103192 | Kurt Zouma | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 951 | Phil Jones | 76359 | Phil Jones | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 964 | Kyle Bartley | 59940 | Kyle Bartley | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 966 | Alex Oxlade-Chamberlain | 81880 | Alex Oxlade-Chamberlain | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 971 | Harry Winks | 157668 | Harry Winks | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 973 | Paulo Gazzaniga | 102884 | Paulo Gazzaniga | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 985 | Mason Holgate | 194164 | Mason Holgate | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 986 | Danny Ings | 84939 | Danny Ings | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 987 | Joseph Gomez | 171287 | Joseph Gomez | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 1006 | Luke Shaw | 106760 | Luke Shaw | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 1013 | Sam Field | 195864 | Sam Field | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 1018 | Josh Cullen | 172567 | Josh Cullen | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 1024 | Tyrone Mings | 149484 | Tyrone Mings | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 1036 | Jack Wilshere | 54102 | Jack Wilshere | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 1042 | Tom Davies | 173807 | Tom Davies | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 1084 | Jonjoe Kenny | 153673 | Jonjoe Kenny | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 1178 | Davide Zappacosta | 105700 | Davide Zappacosta | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 1203 | Wesley Hoedt | 167075 | Wesley Hoedt | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 1245 | Emerson | 109533 | Emerson Palmieri dos Santos | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 1250 | Mohamed Salah | 118748 | Mohamed Salah | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 1299 | Mario Lemina | 151086 | Mario Lemina | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 1383 | Manolo Gabbiadini | 61548 | Manolo Gabbiadini | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 1512 | João Mário | 109788 | João Mário Naval Costa Eduardo | name-variant | high | 1.03 | web-name-exact |
| 1718 | 1621 | Marcos Alonso | 82263 | Marcos Alonso | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 1651 | Tom Heaton | 21205 | Tom Heaton | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 1652 | Matthew Lowton | 68983 | Matthew Lowton | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 1653 | Michael Keane | 106611 | Michael Keane | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 1654 | Ben Mee | 51927 | Ben Mee | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 1655 | Stephen Ward | 40616 | Stephen Ward | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 1657 | Steven Defour | 39847 | Steven Defour | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 1660 | Andre Gray | 73426 | Andre Gray | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 1661 | Sam Vokes | 40399 | Sam Vokes | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 1663 | Johann Berg Gudmundsson | 60586 | Johann Berg Gudmundsson | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 1665 | James Tarkowski | 17761 | James Tarkowski | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 1676 | David Luiz | 41270 | David Luiz Moreira Marinho | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 1677 | Nathaniel Chalobah | 89085 | Nathaniel Chalobah | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 1678 | Michy Batshuayi | 94245 | Michy Batshuayi | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 1679 | Dominic Solanke | 154566 | Dominic Solanke | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 1682 | Islam Slimani | 149828 | Islam Slimani | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 1683 | Ryan Fraser | 90105 | Ryan Fraser | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 1687 | Harry Maguire | 95658 | Harry Maguire | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 1688 | Andrew Robertson | 122798 | Andrew Robertson | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 1689 | Jake Livermore | 49944 | Jake Livermore | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 1699 | Shkodran Mustafi | 69140 | Shkodran Mustafi | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 1719 | Javier Manquillo | 109528 | Javier Manquillo | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 1723 | Roberto Pereyra | 61566 | Roberto Pereyra | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 1725 | Christian Kabasele | 85624 | Christian Kabasele | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 1726 | Abdoulaye Doucouré | 121599 | Abdoulaye Doucouré | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 1727 | Alfie Mawson | 149266 | Alfie Mawson | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 1728 | Fernando Llorente | 19760 | Fernando Llorente | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 1729 | Georges-Kévin Nkoudou | 168566 | Georges-Kévin Nkoudou | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 1730 | Vincent Janssen | 165990 | Vincent Janssen | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 1731 | Claudio Bravo | 33148 | Claudio Bravo | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 1734 | Sofiane Boufal | 128198 | Sofiane Boufal | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 1735 | Jack Stephens | 88900 | Jack Stephens | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 1736 | Oliver McBurnie | 169432 | Oliver McBurnie | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 1737 | Matt Phillips | 50229 | Matt Phillips | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 1738 | Hal Robson-Kanu | 49440 | Hal Robson-Kanu | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 1739 | Eric Bailly | 197365 | Eric Bailly | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 1740 | Paul Pogba | 74208 | Paul Pogba | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 1746 | Jeff Hendrick | 83314 | Jeff Hendrick | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 1747 | Kevin Long | 41674 | Kevin Long | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 1748 | Lys Mousset | 178304 | Lys Mousset | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 1749 | Rob Holding | 156074 | Rob Holding | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 1750 | Ainsley Maitland-Niles | 154043 | Ainsley Maitland-Niles | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 1759 | Ben Hamer | 38038 | Ben Hamer | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 1760 | Arthur Masuaku | 105717 | Arthur Masuaku | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 1763 | Stefano Okaka | 20046 | Stefano Okaka | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 1764 | Ramadan Sobhi | 205102 | Ramadan Sobhi | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 1778 | Freddie Ladapo | 94926 | Olayinka Fredrick Oladotun Ladapo | name-variant | high | 1.03 | team-and-shared-name-tokens |
| 1718 | 1789 | Lewis Cook | 155408 | Lewis Cook | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 1791 | Trent Alexander-Arnold | 169187 | Trent Alexander-Arnold | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 1804 | Álvaro Morata | 88482 | Álvaro Morata | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 1822 | Antonio Rüdiger | 102380 | Antonio Rüdiger | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 2065 | Vicente Iborra | 54513 | Vicente Iborra | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 2244 | Danilo | 100180 | Danilo Luiz da Silva | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 2256 | Jesé | 93127 | Jesé Rodríguez Ruiz | name-variant | high | 1.025 | web-name-exact |
| 1718 | 2329 | Jesús Gámez | 27462 | Jesús Gámez Duarte | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 1718 | 2344 | Christian Atsu | 104953 | Christian Atsu | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 2385 | Mat Ryan | 131897 | Mathew Ryan | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 2498 | Aymeric Laporte | 146941 | Aymeric Laporte | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 2958 | Oleksandr Zinchenko | 206325 | Oleksandr Zinchenko | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 3277 | Alexandre Lacazette | 59966 | Alexandre Lacazette | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 3293 | Lucas Moura | 95715 | Lucas Rodrigues Moura da Silva | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 3389 | Benjamin Mendy | 102826 | Benjamin Mendy | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 3468 | Jonas Lössl | 57513 | Jonas Lössl | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 3600 | Serge Aurier | 80226 | Serge Aurier | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 3635 | Bernardo Silva | 165809 | Bernardo Mota Veiga de Carvalho e Silva | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 3800 | Steve Mounie | 169141 | Steve Mounie | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 3873 | Ezequiel Schelotto | 74375 | Ezequiel Schelotto | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 3979 | Ahmed Hegazy | 77777 | Ahmed El-Sayed Hegazi | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 4422 | Ashley Barnes | 44699 | Ashley Barnes | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 4441 | Matthew James | 61604 | Matty James | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 4456 | Chris Wood | 60689 | Chris Wood | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 4471 | Mohamed Diamé | 28147 | Mohamed Diamé | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 4497 | Anthony Knockaert | 83543 | Anthony Knockaert | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 5043 | Kiko Femenía | 54484 | Francisco Femenía Far | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 5073 | Florian Lejeune | 77359 | Florian Lejeune | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 5215 | Florent Hadergjonaj | 172246 | Florent Hadergjonaj | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 5256 | Oliver Burke | 197937 | Oliver Burke | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 5304 | Mikel Merino | 195384 | Mikel Merino | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 5543 | Gabriel Jesus | 205651 | Gabriel Fernando de Jesus | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 5545 | Wilfred Ndidi | 203341 | Wilfred Ndidi | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 5549 | Luka Milivojevic | 66975 | Luka Milivojevic | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 5552 | Nick Pope | 98747 | Nick Pope | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 5553 | Declan Rice | 204480 | Declan Rice | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 5555 | Dominic Calvert-Lewin | 177815 | Dominic Calvert-Lewin | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 5556 | Ademola Lookman | 219352 | Ademola Lookman | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 5560 | Scott McTominay | 195851 | Scott McTominay | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 5562 | Rekeem Harper | 232427 | Rekeem Harper | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 5565 | Josh Sims | 153379 | Joshua Sims | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 5568 | Connor Roberts | 192290 | Connor Roberts | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 5584 | Aaron Wan-Bissaka | 214590 | Aaron Wan-Bissaka | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 5767 | Fousseni Diabate | 210207 | Fousseni Diabaté | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 6026 | Richarlison | 212319 | Richarlison de Andrade | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 6027 | Jairo Riedewald | 173954 | Jairo Riedewald | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 6029 | Tommy Smith | 104545 | Tommy Smith | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 6030 | Zanka | 48760 | Mathias Jorgensen | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 6031 | Christopher Schindler | 85368 | Christopher Schindler | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 6032 | Chris Löwe | 54284 | Chris Löwe | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 6033 | Aaron Mooy | 74471 | Aaron Mooy | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 6034 | Philip Billing | 168991 | Philip Billing | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 6035 | Collin Quaner | 84112 | Collin Quaner | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 6036 | Rajiv van La Parra | 51344 | Rajiv van La Parra | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 6037 | Danny Williams | 80755 | Danny Williams | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 6038 | Laurent Depoitre | 147303 | Laurent Depoitre | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 6042 | Jan Bednarek | 171771 | Jan Bednarek | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 6044 | Charlie Taylor | 103914 | Charlie Taylor | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 6046 | Bruno | 11352 | Bruno Saltor Grau | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 6047 | Shane Duffy | 61933 | Shane Duffy | carried-forward | high | 1 | carried-from-2223 |
| 1718 | 6048 | Lewis Dunk | 83299 | Lewis Dunk | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 6049 | Solly March | 109345 | Solomon March | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 6050 | Davy Pröpper | 66242 | Davy Pröpper | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 6051 | Dale Stephens | 40845 | Dale Stephens | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 6054 | Ederson | 121160 | Ederson Santana de Moraes | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 6055 | Phil Foden | 209244 | Phil Foden | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 6062 | Isaac Hayden | 153127 | Isaac Hayden | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 6063 | Jacob Murphy | 114243 | Jacob Murphy | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 6067 | Terence Kongolo | 109434 | Terence Kongolo | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 6080 | Victor Lindelöf | 184667 | Victor Lindelöf | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 6104 | Will Hughes | 108413 | Will Hughes | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 6105 | Gaëtan Bong | 42748 | Gaëtan Bong | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 6231 | José Izquierdo | 167473 | José Heriberto Izquierdo Mena | carried-forward | high | 1 | carried-from-2021 |
| 1718 | 6249 | Davinson Sánchez | 173904 | Davinson Sánchez | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 6276 | Nikola Vlasic | 180151 | Nikola Vlasic | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 6296 | Abdelhamid Sabiri | 246878 | Abdelhamid Sabiri | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 6301 | Jonathan Hogg | 79619 | Jonathan Hogg | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 6369 | Ethan Ampadu | 199598 | Ethan Ampadu | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 6409 | Beram Kayal | 38490 | Beram Kayal | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 6410 | Jack Simpson | 222434 | Jack Simpson | carried-forward | high | 1 | carried-from-1920 |
| 1718 | 6418 | Hamza Choudhury | 197469 | Hamza Choudhury | carried-forward | high | 1 | carried-from-2425 |
| 1718 | 6456 | Callum Hudson-Odoi | 209046 | Callum Hudson-Odoi | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 6457 | Emerson Hyndman | 122342 | Emerson Hyndman | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 6464 | Adrien Silva | 46483 | Adrien Sebastian Perruchet Silva | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 6477 | Cenk Tosun | 66838 | Cenk Tosun | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 6482 | Eddie Nketiah | 205533 | Edward Nketiah | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 6492 | Reiss Nelson | 200641 | Reiss Nelson | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 6504 | Michael Obafemi | 220598 | Michael Obafemi | carried-forward | high | 1 | carried-from-2324 |
| 1718 | 6525 | Badou Ndiaye | 163463 | Papa Alioune Ndiaye | name-variant | high | 1.025 | web-name-exact |
| 1718 | 6531 | Alexander Sørloth | 143877 | Alexander Sørloth | carried-forward | high | 1 | carried-from-1819 |
| 1718 | 6532 | Martin Dubravka | 67089 | Martin Dubravka | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 6542 | Jürgen Locadia | 106757 | Jürgen Locadia | carried-forward | high | 1 | carried-from-2122 |
| 1718 | 6544 | Lukas Nmecha | 174594 | Lukas Nmecha | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 6630 | Joe Willock | 200089 | Joseph Willock | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 6681 | Harvey Barnes | 201666 | Harvey Barnes | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 6722 | Konstantinos Mavropanos | 233963 | Konstantinos Mavropanos | carried-forward | high | 1 | carried-from-2526 |
| 1718 | 6756 | Dwight McNeil | 433154 | Dwight McNeil | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 37 | Loris Karius | 104542 | Loris Karius | carried-forward | high | 1 | carried-from-2324 |
| 1617 | 202 | Håvard Nordtveit | 43626 | Håvard Nordtveit | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 204 | Granit Xhaka | 84450 | Granit Xhaka | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 265 | Ragnar Klavan | 33871 | Ragnar Klavan | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 314 | Ilkay Gündogan | 59859 | Ilkay Gündogan | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 317 | Henrikh Mkhitaryan | 57249 | Henrikh Mkhitaryan | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 332 | Joel Matip | 60914 | Joel Matip | carried-forward | high | 1 | carried-from-2324 |
| 1617 | 337 | Leroy Sané | 182156 | Leroy Sané | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 343 | Pierre-Emile Højbjerg | 132015 | Pierre-Emile Højbjerg | carried-forward | high | 1 | carried-from-2324 |
| 1617 | 447 | Kevin De Bruyne | 61366 | Kevin De Bruyne | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 453 | Son Heung-Min | 85971 | Heung-Min Son | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 455 | Artur Boruc | 18726 | Artur Boruc | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 456 | Simon Francis | 15149 | Simon Francis | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 458 | Steve Cook | 56917 | Steve Cook | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 459 | Charlie Daniels | 41320 | Charlie Daniels | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 460 | Andrew Surman | 15237 | Andrew Surman | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 462 | Dan Gosling | 40387 | Dan Gosling | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 463 | Junior Stanislas | 56872 | Junior Stanislas | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 465 | Joshua King | 78007 | Joshua King | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 466 | Marc Pugh | 20037 | Marc Pugh | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 468 | Callum Wilson | 75115 | Callum Wilson | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 475 | Lucas Leiva | 43191 | Leiva Lucas | name-variant | high | 1.03 | unordered-full-name-exact |
| 1617 | 477 | Brad Smith | 120447 | Bradley Smith | name-variant | high | 1.047 | team-and-shared-name-tokens |
| 1617 | 480 | Joe Allen | 40555 | Joe Allen | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 481 | Jordon Ibe | 103912 | Jordon Ibe | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 482 | Roberto Firmino | 92217 | Roberto Firmino | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 483 | Daniel Sturridge | 40755 | Daniel Sturridge | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 484 | Divock Origi | 152760 | Divock Origi | carried-forward | high | 1 | carried-from-2324 |
| 1617 | 485 | Mamadou Sakho | 40784 | Mamadou Sakho | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 486 | Adam Lallana | 39155 | Adam Lallana | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 487 | Simon Mignolet | 66797 | Simon Mignolet | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 488 | Philippe Coutinho | 84583 | Philippe Coutinho | carried-forward | high | 1 | carried-from-2324 |
| 1617 | 489 | James Milner | 15157 | James Milner | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 491 | Petr Cech | 11334 | Petr Cech | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 492 | Héctor Bellerín | 98745 | Héctor Bellerín | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 493 | Gabriel | 158074 | Gabriel Armando de Abreu | name-variant | high | 1.03 | web-name-exact |
| 1617 | 494 | Laurent Koscielny | 51507 | Laurent Koscielny | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 495 | Nacho Monreal | 38411 | Nacho Monreal | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 496 | Mohamed Elneny | 153256 | Mohamed Elneny | carried-forward | high | 1 | carried-from-2324 |
| 1617 | 497 | Francis Coquelin | 56864 | Francis Coquelin | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 498 | Alexis Sánchez | 37265 | Alexis Sánchez | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 499 | Mesut Özil | 37605 | Mesut Özil | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 500 | Alex Iwobi | 153133 | Alex Iwobi | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 501 | Danny Welbeck | 50175 | Danny Welbeck | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 502 | Olivier Giroud | 44346 | Olivier Giroud | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 503 | Theo Walcott | 20467 | Theo Walcott | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 504 | Aaron Ramsey | 41792 | Aaron Ramsey | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 505 | David Ospina | 48844 | David Ospina | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 507 | Per Mertesacker | 17127 | Per Mertesacker | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 508 | Calum Chambers | 101184 | Calum Chambers | carried-forward | high | 1 | carried-from-2324 |
| 1617 | 509 | Wayne Hennessey | 20066 | Wayne Hennessey | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 510 | Joel Ward | 55494 | Joel Ward | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 511 | Damien Delaney | 7906 | Damien Delaney | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 512 | Scott Dann | 19188 | Scott Dann | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 513 | Pape Souaré | 79228 | Pape Souaré | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 514 | Jason Puncheon | 19197 | Jason Puncheon | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 516 | Yohan Cabaye | 27341 | Yohan Cabaye | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 518 | Yannick Bolasie | 55452 | Yannick Bolasie | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 519 | Connor Wickham | 59125 | Connor Wickham | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 520 | Bakary Sako | 44343 | Bakary Sako | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 522 | Wilfried Zaha | 82403 | Wilfried Zaha | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 524 | Adrian Mariappa | 20145 | Adrian Mariappa | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 525 | Martin Kelly | 58786 | Martin Kelly | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 526 | Lee Chung-yong | 75773 | Chung-yong Lee | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 527 | Adrián | 60706 | Adrián San Miguel del Castillo | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 528 | Angelo Ogbonna | 40669 | Angelo Ogbonna | carried-forward | high | 1 | carried-from-2324 |
| 1617 | 529 | Winston Reid | 48717 | Winston Reid | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 530 | James Tomkins | 49413 | James Tomkins | carried-forward | high | 1 | carried-from-2324 |
| 1617 | 531 | Michail Antonio | 57531 | Michail Antonio | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 532 | Cheikhou Kouyaté | 55037 | Cheikhou Kouyaté | carried-forward | high | 1 | carried-from-2324 |
| 1617 | 533 | Mark Noble | 18073 | Mark Noble | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 534 | Aaron Cresswell | 55459 | Aaron Cresswell | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 535 | Manuel Lanzini | 86934 | Manuel Lanzini | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 537 | Andy Carroll | 40142 | Andy Carroll | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 540 | Darren Randolph | 32259 | Darren Randolph | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 541 | Victor Moses | 49013 | Victor Moses | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 542 | Pedro Obiang | 59779 | Pedro Obiang | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 545 | Kieran Gibbs | 42427 | Kieran Gibbs | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 546 | David de Gea | 51940 | David de Gea | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 548 | Daley Blind | 58877 | Daley Blind | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 549 | Timothy Fosu-Mensah | 201084 | Timothy Fosu-Mensah | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 550 | Marcos Rojo | 58893 | Marcos Rojo | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 551 | Morgan Schneiderlin | 42774 | Morgan Schneiderlin | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 552 | Ander Herrera | 59846 | Ander Herrera | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 553 | Anthony Martial | 148225 | Anthony Martial | carried-forward | high | 1 | carried-from-2324 |
| 1617 | 554 | Juan Mata | 43670 | Juan Mata | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 556 | Marcus Rashford | 176297 | Marcus Rashford | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 557 | Matteo Darmian | 40002 | Matteo Darmian | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 558 | Jesse Lingard | 109322 | Jesse Lingard | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 559 | Paddy McNair | 160817 | Patrick McNair | name-variant | high | 0.999 | team-and-shared-name-tokens |
| 1617 | 560 | Sergio Romero | 42899 | Sergio Romero | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 564 | Heurelho Gomes | 18656 | Heurelho Gomes | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 565 | Nyom | 67527 | Allan-Roméo Nyom | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 566 | Sebastian Prödl | 41945 | Sebastian Prödl | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 567 | Miguel Britos | 52153 | Miguel Britos | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 568 | José Holebas | 40868 | José Holebas | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 571 | Ben Watson | 16045 | Ben Watson | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 572 | Etienne Capoue | 38439 | Etienne Capoue | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 573 | Odion Ighalo | 58498 | Odion Ighalo | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 574 | Troy Deeney | 41725 | Troy Deeney | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 575 | Nordin Amrabat | 44604 | Nordin Amrabat | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 579 | Nathan Aké | 126184 | Nathan Aké | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 581 | Craig Cathcart | 41338 | Craig Cathcart | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 584 | Joel Robles | 78315 | Joel Robles | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 585 | Seamus Coleman | 59949 | Seamus Coleman | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 586 | John Stones | 97299 | John Stones | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 587 | Phil Jagielka | 7645 | Phil Jagielka | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 588 | Leighton Baines | 12745 | Leighton Baines | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 589 | James McCarthy | 50472 | James McCarthy | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 590 | Gareth Barry | 1632 | Gareth Barry | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 591 | Gerard Deulofeu | 94924 | Gerard Deulofeu | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 592 | Ross Barkley | 88894 | Ross Barkley | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 593 | Aaron Lennon | 17349 | Aaron Lennon | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 594 | Romelu Lukaku | 66749 | Romelu Lukaku | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 595 | Kevin Mirallas | 26901 | Kevin Mirallas | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 596 | Tom Cleverley | 43250 | Tom Cleverley | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 597 | Ramiro Funes Mori | 121221 | Ramiro Funes Mori | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 599 | Oumar Niasse | 113688 | Oumar Niasse | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 602 | Dejan Lovren | 38454 | Dejan Lovren | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 603 | Nathaniel Clyne | 57328 | Nathaniel Clyne | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 604 | Emre Can | 112338 | Emre Can | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 605 | Jordan Henderson | 56979 | Jordan Henderson | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 606 | Christian Benteke | 54861 | Christian Benteke | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 608 | Alberto Moreno | 100059 | Alberto Moreno | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 610 | Pablo Zabaleta | 20658 | Pablo Zabaleta | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 611 | Nicolás Otamendi | 57410 | Nicolás Otamendi | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 612 | Vincent Kompany | 17476 | Vincent Kompany | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 614 | Fernandinho | 27789 | Fernando Luiz Rosa | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 615 | Fernando | 52538 | Fernando Francisco Reges | name-variant | high | 1.03 | season-stats-supported:web-name-exact |
| 1617 | 617 | David Silva | 20664 | David Silva | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 618 | Raheem Sterling | 103955 | Raheem Sterling | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 619 | Sergio Agüero | 37572 | Sergio Agüero | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 620 | Kelechi Iheanacho | 173515 | Kelechi Iheanacho | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 622 | Wilfried Bony | 57001 | Wilfried Bony | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 624 | Willy Caballero | 20310 | Willy Caballero | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 627 | Antonio Valencia | 20695 | Antonio Valencia | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 628 | Chris Smalling | 55909 | Chris Smalling | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 629 | Wayne Rooney | 13017 | Wayne Rooney | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 630 | Marouane Fellaini | 41184 | Marouane Fellaini | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 631 | Ashley Young | 18892 | Ashley Young | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 633 | James McArthur | 50471 | James McArthur | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 637 | Hugo Lloris | 37915 | Hugo Lloris | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 638 | Kyle Walker | 58621 | Kyle Walker | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 639 | Toby Alderweireld | 55605 | Toby Alderweireld | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 640 | Jan Vertonghen | 39194 | Jan Vertonghen | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 641 | Danny Rose | 38290 | Danny Rose | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 642 | Mousa Dembélé | 39104 | Mousa Dembélé | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 643 | Eric Dier | 93264 | Eric Dier | carried-forward | high | 1 | carried-from-2324 |
| 1617 | 644 | Erik Lamela | 62974 | Erik Lamela | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 645 | Dele Alli | 108823 | Bamidele Alli | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 646 | Christian Eriksen | 80607 | Christian Eriksen | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 647 | Harry Kane | 78830 | Harry Kane | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 648 | Nacer Chadli | 54908 | Nacer Chadli | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 650 | Kevin Wimmer | 97485 | Kevin Wimmer | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 651 | Michel Vorm | 39215 | Michel Vorm | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 652 | Kieran Trippier | 77794 | Kieran Trippier | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 653 | Tom Carroll | 93464 | Tom Carroll | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 654 | Michael Carrick | 2404 | Michael Carrick | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 655 | James Collins | 8380 | James Collins | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 656 | Diafra Sakho | 73889 | Diafra Sakho | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 660 | Ben Davies | 115556 | Ben Davies | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 661 | Josh Onomah | 168765 | Joshua Onomah | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 662 | Brad Guzan | 41705 | Bradley Guzan | name-variant | high | 1.047 | team-and-shared-name-tokens |
| 1617 | 668 | Idrissa Gueye | 80801 | Idrissa Gueye | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 669 | Ashley Westwood | 60551 | Ashley Westwood | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 672 | Jordan Ayew | 80146 | Jordan Ayew | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 680 | Thibaut Courtois | 60772 | Thibaut Courtois | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 681 | César Azpilicueta | 41328 | César Azpilicueta | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 682 | Branislav Ivanovic | 41135 | Branislav Ivanovic | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 686 | Cesc Fàbregas | 17878 | Cesc Fàbregas | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 687 | Pedro | 49579 | Pedro Rodríguez Ledesma | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 688 | Ruben Loftus-Cheek | 126187 | Ruben Loftus-Cheek | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 689 | Kenedy | 167767 | Robert Kenedy Nunes do Nascimento | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 692 | Oscar | 61262 | Oscar dos Santos Emboaba Junior | name-variant | high | 1.03 | web-name-exact |
| 1617 | 694 | Asmir Begovic | 40349 | Asmir Begovic | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 697 | Nemanja Matic | 62398 | Nemanja Matic | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 699 | Gary Cahill | 19419 | Gary Cahill | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 700 | Willian | 47431 | Willian Borges Da Silva | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 701 | Eden Hazard | 42786 | Eden Hazard | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 706 | Lukasz Fabianski | 37096 | Lukasz Fabianski | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 707 | Angel Rangel | 42996 | Angel Rangel | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 708 | Federico Fernández | 57145 | Federico Fernández | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 709 | Ashley Williams | 19159 | Ashley Williams | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 710 | Neil Taylor | 47390 | Neil Taylor | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 711 | Leroy Fer | 49277 | Leroy Fer | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 712 | Jack Cork | 40145 | Jack Cork | carried-forward | high | 1 | carried-from-2324 |
| 1617 | 713 | André Ayew | 45124 | André Ayew | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 714 | Gylfi Sigurdsson | 55422 | Gylfi Sigurdsson | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 718 | Kyle Naughton | 49539 | Kyle Naughton | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 719 | Wayne Routledge | 11829 | Wayne Routledge | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 723 | Ki Sung-yueng | 76542 | Sung-yueng Ki | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 725 | Ola Aina | 159506 | Ola Aina | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 730 | Patrick van Aanholt | 74230 | Patrick van Aanholt | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 733 | Jack Rodwell | 49384 | Jack Rodwell | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 735 | Jermain Defoe | 7958 | Jermain Defoe | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 736 | Younes Kaboul | 37742 | Younes Kaboul | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 741 | Jordan Pickford | 111234 | Jordan Pickford | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 745 | Kasper Schmeichel | 17745 | Kasper Schmeichel | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 746 | Danny Simpson | 40725 | Danny Simpson | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 748 | Wes Morgan | 15033 | Wes Morgan | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 749 | Christian Fuchs | 37402 | Christian Fuchs | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 750 | Riyad Mahrez | 103025 | Riyad Mahrez | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 751 | N&#039;Golo Kanté | 116594 | N'Golo Kanté | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 752 | Daniel Drinkwater | 61603 | Daniel Drinkwater | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 753 | Marc Albrighton | 51938 | Marc Albrighton | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 754 | Shinji Okazaki | 78412 | Shinji Okazaki | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 755 | Jamie Vardy | 101668 | Jamie Vardy | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 756 | Leonardo Ulloa | 54316 | Leonardo Ulloa | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 757 | Jeffrey Schlupp | 86417 | Jeffrey Schlupp | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 759 | Daniel Amartey | 155569 | Daniel Amartey | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 762 | Demarai Gray | 172632 | Demarai Gray | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 764 | Daryl Janmaat | 52940 | Daryl Janmaat | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 771 | Georginio Wijnaldum | 41733 | Georginio Wijnaldum | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 772 | Moussa Sissoko | 45268 | Moussa Sissoko | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 775 | Andros Townsend | 60252 | Andros Townsend | carried-forward | high | 1 | carried-from-2324 |
| 1617 | 782 | Ben Chilwell | 172850 | Benjamin Chilwell | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 783 | Nathan Dyer | 21083 | Nathan Dyer | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 784 | Andy King | 13152 | Andy King | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 789 | Robbie Brady | 90517 | Robbie Brady | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 790 | Nathan Redmond | 83283 | Nathan Redmond | carried-forward | high | 1 | carried-from-2324 |
| 1617 | 798 | Martin Olsson | 28654 | Martin Olsson | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 802 | Diego Costa | 18507 | Diego Da Silva Costa | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 803 | Ben Foster | 9089 | Ben Foster | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 804 | Craig Dawson | 60232 | Craig Dawson | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 806 | Gareth McAuley | 19272 | Gareth McAuley | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 807 | Jonny Evans | 37642 | Jonny Evans | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 808 | Claudio Yacob | 55829 | Claudio Yacob | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 809 | Darren Fletcher | 14295 | Darren Fletcher | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 811 | Saido Berahino | 91972 | Saido Berahino | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 813 | Salomón Rondón | 57134 | Salomón Rondón | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 814 | James McClean | 63370 | James McClean | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 822 | Patrick Bamford | 106617 | Patrick Bamford | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 825 | Adam Smith | 54469 | Adam Smith | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 826 | Benik Afobe | 88498 | Benik Afobe | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 830 | Leon Britton | 15114 | Leon Britton | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 831 | Fraser Forster | 40383 | Fraser Forster | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 832 | Cuco Martina | 56192 | Cuco Martina | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 833 | Virgil van Dijk | 97032 | Virgil van Dijk | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 834 | José Fonte | 38580 | Jose Fonte | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 835 | Ryan Bertrand | 40146 | Ryan Bertrand | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 836 | Victor Wanyama | 54756 | Victor Wanyama | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 838 | Sadio Mané | 110979 | Sadio Mané | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 839 | Shane Long | 20452 | Shane Long | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 840 | Dusan Tadic | 62399 | Dusan Tadic | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 842 | Oriol Romeu | 78056 | Oriol Romeu Vidal | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 843 | James Ward-Prowse | 101178 | James Ward-Prowse | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 844 | Jay Rodriguez | 44683 | Jay Rodriguez | carried-forward | high | 1 | carried-from-2324 |
| 1617 | 845 | Maya Yoshida | 80447 | Maya Yoshida | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 847 | Cédric Soares | 58822 | Cédric Soares | carried-forward | high | 1 | carried-from-2324 |
| 1617 | 848 | Charlie Austin | 78356 | Charlie Austin | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 856 | Jack Butland | 105666 | Jack Butland | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 857 | Phil Bardsley | 17997 | Phil Bardsley | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 859 | Geoff Cameron | 50089 | Geoff Cameron | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 863 | Jonathan Walters | 12813 | Jonathan Walters | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 864 | Ibrahim Afellay | 19568 | Ibrahim Afellay | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 865 | Marko Arnautovic | 41464 | Marko Arnautovic | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 868 | Mame Biram Diouf | 61858 | Mame Biram Diouf | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 871 | Bojan | 40276 | Bojan Krkic | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 872 | Peter Crouch | 3773 | Peter Crouch | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 873 | Charlie Adam | 20208 | Charlie Adam | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 876 | Fabian Delph | 41823 | Fabian Delph | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 877 | Samir Nasri | 28554 | Samir Nasri | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 878 | Yaya Touré | 14664 | Gnegneri Yaya Touré | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 881 | Harry Arter | 48615 | Harry Arter | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 883 | Steven Davis | 17339 | Steven Davis | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 884 | Matt Targett | 169359 | Matt Targett | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 886 | Ryan Shawcross | 37869 | Ryan Shawcross | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 887 | Erik Pieters | 39487 | Erik Pieters | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 888 | Xherdan Shaqiri | 68312 | Xherdan Shaqiri | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 896 | Jay Fulton | 96305 | Jay Fulton | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 900 | Adama Traoré | 159533 | Adama Traoré | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 902 | Sam Byram | 113564 | Sam Byram | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 904 | Chris Brunt | 19151 | Chris Brunt | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 910 | Harrison Reed | 153366 | Harrison Reed | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 934 | Axel Tuanzebe | 180804 | Axel Tuanzebe | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 935 | Kurt Zouma | 103192 | Kurt Zouma | carried-forward | high | 1 | carried-from-2324 |
| 1617 | 938 | Carl Jenkinson | 80254 | Carl Jenkinson | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 944 | Glen Johnson | 9047 | Glen Johnson | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 951 | Phil Jones | 76359 | Phil Jones | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 966 | Alex Oxlade-Chamberlain | 81880 | Alex Oxlade-Chamberlain | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 971 | Harry Winks | 157668 | Harry Winks | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 972 | Jerome Sinclair | 133801 | Jerome Sinclair | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 974 | Yohan Benalouane | 41321 | Yohan Benalouane | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 985 | Mason Holgate | 194164 | Mason Holgate | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 990 | James Morrison | 18008 | James Morrison | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 1006 | Luke Shaw | 106760 | Luke Shaw | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 1013 | Sam Field | 195864 | Sam Field | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 1017 | Matej Vydra | 81183 | Matej Vydra | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 1024 | Tyrone Mings | 149484 | Tyrone Mings | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 1036 | Jack Wilshere | 54102 | Jack Wilshere | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 1042 | Tom Davies | 173807 | Tom Davies | carried-forward | high | 1 | carried-from-2324 |
| 1617 | 1055 | Aleix García | 178871 | Aleix García Serrano | name-variant | high | 1.06 | team-and-close-first-name-expanded-last-name |
| 1617 | 1070 | Sullay Kaikai | 138009 | Sullay Kaikai | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 1084 | Jonjoe Kenny | 153673 | Jonjoe Kenny | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 1383 | Manolo Gabbiadini | 61548 | Manolo Gabbiadini | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 1621 | Marcos Alonso | 82263 | Marcos Alonso | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 1651 | Tom Heaton | 21205 | Tom Heaton | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 1652 | Matthew Lowton | 68983 | Matthew Lowton | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 1653 | Michael Keane | 106611 | Michael Keane | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 1654 | Ben Mee | 51927 | Ben Mee | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 1655 | Stephen Ward | 40616 | Stephen Ward | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 1657 | Steven Defour | 39847 | Steven Defour | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 1659 | Scott Arfield | 39158 | Scott Arfield | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 1660 | Andre Gray | 73426 | Andre Gray | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 1661 | Sam Vokes | 40399 | Sam Vokes | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 1663 | Johann Berg Gudmundsson | 60586 | Johann Berg Gudmundsson | carried-forward | high | 1 | carried-from-2324 |
| 1617 | 1665 | James Tarkowski | 17761 | James Tarkowski | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 1669 | Marko Grujic | 210237 | Marko Grujic | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 1673 | Edimilson Fernandes | 163526 | Edimilson Fernandes | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 1675 | Ashley Fletcher | 176296 | Ashley Fletcher | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 1676 | David Luiz | 41270 | David Luiz Moreira Marinho | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 1677 | Nathaniel Chalobah | 89085 | Nathaniel Chalobah | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 1678 | Michy Batshuayi | 94245 | Michy Batshuayi | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 1682 | Islam Slimani | 149828 | Islam Slimani | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 1683 | Ryan Fraser | 90105 | Ryan Fraser | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 1685 | Ahmed Elmohamady | 37339 | Ahmed Elmohamady | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 1687 | Harry Maguire | 95658 | Harry Maguire | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 1688 | Andrew Robertson | 122798 | Andrew Robertson | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 1689 | Jake Livermore | 49944 | Jake Livermore | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 1690 | Sam Clucas | 74033 | Sam Clucas | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 1691 | Robert Snodgrass | 18987 | Robert Snodgrass | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 1697 | Eldin Jakupovic | 11974 | Eldin Jakupovic | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 1699 | Shkodran Mustafi | 69140 | Shkodran Mustafi | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 1700 | Lucas Pérez | 155851 | Lucas Pérez | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 1701 | Borja Bastón | 83091 | Borja Bastón | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 1702 | Mike van der Hoorn | 97615 | Mike van der Hoorn | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 1707 | Ben Gibson | 83312 | Ben Gibson | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 1711 | Adam Forshaw | 80179 | Adam Forshaw | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 1716 | Bernardo | 55317 | Bernardo Espinosa Zúñiga | name-variant | high | 1.03 | web-name-exact |
| 1617 | 1719 | Javier Manquillo | 109528 | Javier Manquillo | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 1723 | Roberto Pereyra | 61566 | Roberto Pereyra | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 1724 | Isaac Success | 173514 | Isaac Success | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 1725 | Christian Kabasele | 85624 | Christian Kabasele | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 1726 | Abdoulaye Doucouré | 121599 | Abdoulaye Doucouré | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 1727 | Alfie Mawson | 149266 | Alfie Mawson | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 1728 | Fernando Llorente | 19760 | Fernando Llorente | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 1729 | Georges-Kévin Nkoudou | 168566 | Georges-Kévin Nkoudou | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 1730 | Vincent Janssen | 165990 | Vincent Janssen | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 1731 | Claudio Bravo | 33148 | Claudio Bravo | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 1732 | Nolito | 86173 | Manuel Agudo Durán | name-variant | high | 1.03 | web-name-exact |
| 1617 | 1733 | Sam McQueen | 153373 | Sam McQueen | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 1734 | Sofiane Boufal | 128198 | Sofiane Boufal | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 1735 | Jack Stephens | 88900 | Jack Stephens | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 1736 | Oliver McBurnie | 169432 | Oliver McBurnie | carried-forward | high | 1 | carried-from-2324 |
| 1617 | 1737 | Matt Phillips | 50229 | Matt Phillips | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 1738 | Hal Robson-Kanu | 49440 | Hal Robson-Kanu | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 1739 | Eric Bailly | 197365 | Eric Bailly | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 1740 | Paul Pogba | 74208 | Paul Pogba | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 1741 | Zlatan Ibrahimovic | 9808 | Zlatan Ibrahimovic | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 1742 | Lee Grant | 6744 | Lee Grant | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 1743 | Bruno Martins Indi | 85352 | Bruno Martins Indi | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 1745 | Josh Tymon | 221267 | Josh Tymon | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 1746 | Jeff Hendrick | 83314 | Jeff Hendrick | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 1747 | Kevin Long | 41674 | Kevin Long | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 1748 | Lys Mousset | 178304 | Lys Mousset | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 1749 | Rob Holding | 156074 | Rob Holding | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 1750 | Ainsley Maitland-Niles | 154043 | Ainsley Maitland-Niles | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 1752 | Fabio | 54771 | Fabio Pereira da Silva | name-variant | high | 1.03 | web-name-exact |
| 1617 | 1757 | Nsue | 48771 | Emilio Nsue Lopez | name-variant | high | 1.03 | web-name-exact |
| 1617 | 1760 | Arthur Masuaku | 105717 | Arthur Masuaku | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 1762 | Ovie Ejaria | 154051 | Oviemuno Ejaria | name-variant | high | 1.045 | team-and-shared-name-tokens |
| 1617 | 1763 | Stefano Okaka | 20046 | Stefano Okaka | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 1764 | Ramadan Sobhi | 205102 | Ramadan Sobhi | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 1776 | Jarrod Bowen | 178186 | Jarrod Bowen | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 1777 | Julien Ngoy | 200455 | Julien Ngoy | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 1784 | Jérémy Pied | 40833 | Jérémy Pied | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 1785 | Nampalys Mendy | 86881 | Nampalys Mendy | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 1789 | Lewis Cook | 155408 | Lewis Cook | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 1791 | Trent Alexander-Arnold | 169187 | Trent Alexander-Arnold | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 3231 | Kamil Grosicki | 49957 | Kamil Grosicki | carried-forward | high | 1 | carried-from-2021 |
| 1617 | 4401 | Emiliano Martinez | 98980 | Damian Emiliano Martinez | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 4406 | Lazar Markovic | 99323 | Lazar Markovic | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 4422 | Ashley Barnes | 44699 | Ashley Barnes | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 4441 | Matthew James | 61604 | Matthew James | carried-forward | high | 1 | carried-from-1920 |
| 1617 | 5543 | Gabriel Jesus | 205651 | Gabriel Fernando de Jesus | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 5545 | Wilfred Ndidi | 203341 | Wilfred Ndidi | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 5549 | Luka Milivojevic | 66975 | Luka Milivojevic | carried-forward | high | 1 | carried-from-2223 |
| 1617 | 5550 | Evandro | 52287 | Evandro Goebel | name-variant | high | 1.025 | web-name-exact |
| 1617 | 5553 | Declan Rice | 204480 | Declan Rice | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 5554 | Luciano Narsingh | 57586 | Luciano Narsingh | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 5555 | Dominic Calvert-Lewin | 177815 | Dominic Calvert-Lewin | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 5556 | Ademola Lookman | 219352 | Ademola Lookman | carried-forward | high | 1 | carried-from-2122 |
| 1617 | 5557 | Ben Woodburn | 182436 | Ben Woodburn | carried-forward | high | 1 | carried-from-1718 |
| 1617 | 5560 | Scott McTominay | 195851 | Scott McTominay | carried-forward | high | 1 | carried-from-2425 |
| 1617 | 5565 | Josh Sims | 153379 | Joshua Sims | carried-forward | high | 1 | carried-from-1819 |
| 1617 | 5575 | Joel Pereira | 168196 | Joel Dinis Castro Pereira | name-variant | high | 1.03 | season-stats-supported:web-name-exact |
| 1617 | 5597 | Josh Harrop | 156690 | Joshua Harrop | name-variant | high | 1.01 | team-and-shared-name-tokens |
| 1617 | 5598 | Angel Gomes | 209041 | Angel Gomes | carried-forward | high | 1 | carried-from-2526 |
| 1617 | 5601 | Matt Worthington | 224946 | Matthew Worthington | name-variant | high | 1.047 | team-and-shared-name-tokens |

## High 置信抽样复核

按赛季取排序后的前 2 条 high 非 exact 记录，核对名称、球队和位置；抽样结果作为规则回归基线。

| 赛季 | Understat | FPL | Understat 球队 | FPL 球队 | FPL type |
| --- | --- | --- | --- | --- | ---: |
| 2526 | Joelinton (87) | Joelinton Cássio Apolinário de Lira (180974) | Newcastle United | Newcastle | 3 |
| 2526 | Idrissa Gueye (668) | Idrissa Gana Gueye (80801) | Everton | Everton | 3 |
| 2425 | Fabian Schär (76) | Fabian Schär (119471) | Newcastle United | Newcastle | 2 |
| 2425 | Joelinton (87) | Joelinton Cássio Apolinário de Lira (180974) | Newcastle United | Newcastle | 3 |
| 2324 | Timo Werner (65) | Timo Werner (165153) | Tottenham | Spurs | 4 |
| 2324 | Fabian Schär (76) | Fabian Schär (119471) | Newcastle United | Newcastle | 2 |
| 2223 | Fabian Schär (76) | Fabian Schär (119471) | Newcastle United | Newcastle | 2 |
| 2223 | Joelinton (87) | Joelinton Cássio Apolinário de Lira (180974) | Newcastle United | Newcastle | 3 |
| 2122 | Timo Werner (65) | Timo Werner (165153) | Chelsea | Chelsea | 4 |
| 2122 | Fabian Schär (76) | Fabian Schär (119471) | Newcastle United | Newcastle | 2 |
| 2021 | Timo Werner (65) | Timo Werner (165153) | Chelsea | Chelsea | 4 |
| 2021 | Fabian Schär (76) | Fabian Schär (119471) | Newcastle United | Newcastle | 2 |
| 1920 | Lukas Rupp (62) | Lukas Rupp (76306) | Norwich | Norwich | 3 |
| 1920 | Fabian Schär (76) | Fabian Schär (119471) | Newcastle United | Newcastle | 2 |
| 1819 | Yoshinori Muto (47) | Yoshinori Muto (196118) | Newcastle United | Newcastle | 4 |
| 1819 | Fabian Schär (76) | Fabian Schär (119471) | Newcastle United | Newcastle | 2 |
| 1718 | Loris Karius (37) | Loris Karius (104542) | Liverpool | Liverpool | 1 |
| 1718 | Chicharito (191) | Javier Hernández Balcázar (43020) | West Ham | West Ham | 4 |
| 1617 | Loris Karius (37) | Loris Karius (104542) | Liverpool | Liverpool | 1 |
| 1617 | Håvard Nordtveit (202) | Håvard Nordtveit (43626) | West Ham | West Ham | 3 |

## 1415、1516 历史源非 exact 全量日志

1415、1516 按 `1516 → 1415` 倒序核验；使用本地保存的 Pulselive ranked stats identity/season metrics，并用 FPL legacy stats 作为历史球队和统计交叉证据。以下 29 条全部为 high；没有 low 队列，因此不需要人工逐条确认。

| 赛季 | Understat id | Understat 名称 | Understat 球队 | FPL code | FPL 名称 | 官方 stats 名称 | 置信度 | 分数 | 规则 |
| --- | ---: | --- | --- | ---: | --- | --- | --- | ---: | --- |
| 1415 | 493 | Gabriel | Arsenal | 158074 | Gabriel Armando de Abreu | Gabriel Paulista | high | 1 | legacy-persistent-code-override |
| 1415 | 696 | Falcao | Manchester United | 48847 | Radamel Falcao | Radamel Falcao | high | 1.09 | legacy-short-name-position-stats |
| 1415 | 752 | Daniel Drinkwater | Leicester | 61603 | Danny Drinkwater | Danny Drinkwater | high | 1.21 | legacy-name-variant-position-stats |
| 1415 | 789 | Robbie Brady | Hull | 90517 | Robert Brady | Robert Brady | high | 1.21 | legacy-name-variant-position-stats |
| 1415 | 850 | Papiss Demba Cissé | Newcastle United | 42758 | Papiss Cissé | Papiss Cissé | high | 1.21 | legacy-name-variant-position-stats |
| 1415 | 860 | Marc Muniesa | Stoke | 61595 | Muniesa | Muniesa | high | 1.21 | legacy-name-variant-position-stats |
| 1415 | 868 | Mame Biram Diouf | Stoke | 61858 | Mame Diouf | Mame Diouf | high | 1.21 | legacy-name-variant-position-stats |
| 1415 | 918 | Joey O&#039;Brien | West Ham | 19575 | Joseph O'Brien | Joseph O'Brien | high | 1.21 | legacy-name-variant-position-stats |
| 1415 | 965 | Santiago Cazorla | Arsenal | 19524 | Santi Cazorla | Santi Cazorla | high | 1.21 | legacy-name-variant-position-stats |
| 1415 | 977 | Tyias Browning | Everton | 149468 | Tyias Browning | Jiang Guangtai | high | 1 | legacy-persistent-code-override |
| 1415 | 1060 | Jonathan Williams | Crystal Palace | 103100 | Jonny Williams | Jonny Williams | high | 1.128 | legacy-name-variant-position-stats |
| 1415 | 1688 | Andrew Robertson | Hull | 122798 | Andy Robertson | Andy Robertson | high | 1.21 | legacy-name-variant-position-stats |
| 1415 | 4441 | Matthew James | Leicester | 61604 | Matty James | Matty James | high | 1.21 | legacy-name-variant-position-stats |
| 1415 | 4460 | Brad Jones | Liverpool | 9631 | Bradley Jones | Bradley Jones | high | 1.21 | legacy-name-variant-position-stats |
| 1516 | 493 | Gabriel | Arsenal | 158074 | Gabriel Armando de Abreu | Gabriel Paulista | high | 1 | legacy-persistent-code-override |
| 1516 | 565 | Nyom | Watford | 67527 | Allan Nyom | Allan Nyom | high | 1.09 | legacy-short-name-position-stats |
| 1516 | 582 | Jurado | Watford | 17441 | José Manuel Jurado | José Manuel Jurado | high | 1.09 | legacy-short-name-position-stats |
| 1516 | 684 | Abdul Rahman Baba | Chelsea | 118335 | Abdul Baba | Abdul Baba | high | 1.21 | legacy-name-variant-position-stats |
| 1516 | 696 | Falcao | Chelsea | 48847 | Radamel Falcao | Radamel Falcao | high | 1.089 | legacy-short-name-position-stats |
| 1516 | 752 | Daniel Drinkwater | Leicester | 61603 | Danny Drinkwater | Danny Drinkwater | high | 1.21 | legacy-name-variant-position-stats |
| 1516 | 789 | Robbie Brady | Norwich | 90517 | Robert Brady | Robert Brady | high | 1.21 | legacy-name-variant-position-stats |
| 1516 | 850 | Papiss Demba Cissé | Newcastle United | 42758 | Papiss Cissé | Papiss Cissé | high | 1.21 | legacy-name-variant-position-stats |
| 1516 | 860 | Marc Muniesa | Stoke | 61595 | Muniesa | Muniesa | high | 1.21 | legacy-name-variant-position-stats |
| 1516 | 868 | Mame Biram Diouf | Stoke | 61858 | Mame Diouf | Mame Diouf | high | 1.21 | legacy-name-variant-position-stats |
| 1516 | 962 | José Ángel Crespo | Aston Villa | 28386 | José Crespo | José Crespo | high | 1.21 | legacy-name-variant-position-stats |
| 1516 | 965 | Santiago Cazorla | Arsenal | 19524 | Santi Cazorla | Santi Cazorla | high | 1.21 | legacy-name-variant-position-stats |
| 1516 | 977 | Tyias Browning | Everton | 149468 | Tyias Browning | Jiang Guangtai | high | 1 | legacy-persistent-code-override |
| 1516 | 987 | Joseph Gomez | Liverpool | 171287 | Joe Gomez | Joe Gomez | high | 1.21 | legacy-name-variant-position-stats |
| 1516 | 1060 | Jonathan Williams | Crystal Palace | 103100 | Jonny Williams | Jonny Williams | high | 1.128 | legacy-name-variant-position-stats |

原始文件：

- `data/raw/fpl/legacy/pulselive/{1415,1516}-{appearances,mins_played,goals,goal_assist}.json`
- `data/raw/fpl/legacy/fplanalytics/{201415,201516}.json`

## Manual 已确认日志

以下记录由人工逐条确认，写入 `manual_verified`，并作为后续赛季倒序继承依据。

| 赛季 | Understat id | Understat 名称 | FPL code | FPL 名称 | 类型 | 原因 |
| --- | ---: | --- | ---: | --- | --- | --- |

## Low 逐条人工审核队列

以下项目在人工确认前不写入 `auto_verified`。候选顺序只代表当前规则排序，不代表已确认。

| # | 赛季 | Understat id | Understat 名称 | Understat 球队 | 当前候选 FPL | code | 原因 | 分数 | 其他候选 |
| ---: | --- | ---: | --- | --- | --- | ---: | --- | ---: | --- |

## 数据范围说明

- 1617–2526 的审计当时使用旧 FPL history 数据；v3 迁移后这些事实位于统一、显式
  `season_id` 的 `fpl.*` 表。1415、1516 使用本地保存的官方 Pulselive ranked stats
  identity/metrics 与 FPL legacy stats；这些来源只作为 bridge evidence，不创建 history 分区。
- exact normalized full name 不进入非 exact 日志；历史源的 29 条非 exact 已完整列出并全部是 high。
- 该日志只记录身份映射，不改变 Understat canonical tables，也不把映射写入 FPL current tables。
