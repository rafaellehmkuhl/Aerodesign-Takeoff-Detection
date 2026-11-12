"""Gera as texturas dos marcadores ArUco (DICT_4X4_50) usadas pelo simulador."""
import sys, os, cv2
out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "sim", "assets", "aruco")
os.makedirs(out, exist_ok=True)
d = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
for i in range(16):
    img = cv2.aruco.generateImageMarker(d, i, 6)  # 1 px por célula (4x4 + borda preta)
    img = cv2.resize(img, (240, 240), interpolation=cv2.INTER_NEAREST)
    cv2.imwrite(os.path.join(out, f"4x4_50_id{i}.png"), img)
print("ok")
