# Relatório — limite_falha

- Massa 13.41 kg · V estol 11.1 m/s · V rotação 11.9 m/s
- Rotação em t=5.48 s · saiu do chão em t=6.45 s · cruzou o obstáculo em t=7.80 s
- **Verdade: decolagem INVÁLIDA, folga -2.0 cm** (y = -0.44 m)

| Algoritmo | Veredito | Folga | Erro de folga | Acertou | Tempo |
|---|---|---|---|---|---|
| Câmera de linha (banda) | VÁLIDA | +0.0 cm | +20 mm | **NÃO** | 21 s |
| Câmera de linha (coluna) | VÁLIDA | +8.8 cm | +108 mm | **NÃO** | 21 s |
| 3 câmeras + ArUco | INVÁLIDA | -1.8 cm | +2 mm | sim | 77 s |
| 3 câmeras sem marcador | INVÁLIDA | -2.4 cm | -4 mm | sim | 111 s |

- **3 câmeras + ArUco**: pose em 49/51 quadros; erro de posição mediano 19 mm (máx 34 mm; z: viés -1 mm, rmse 10 mm); orientação mediana 0.53° (máx 2.8°).
- **3 câmeras sem marcador**: pose em 47/51 quadros; erro de posição mediano 25 mm (máx 179 mm; z: viés +9 mm, rmse 38 mm); orientação mediana 1.55° (máx 8.5°).
- **Câmera de linha**: 3.0 mm/px no eixo da pista; a aeronave anda 34 mm entre quadros (11.5 px).
