# Monitor de precios — paso 1: validar el scraping de Farmatodo

Este es el primer paso del proyecto. Solo verifica que podemos extraer precios
de Farmatodo correctamente. No hay base de datos, no hay nube, no hay panel.

## Instalación (una sola vez)

Asumiendo que ya tienes Python 3.10+ y Git instalados:

```bash
# 1. Entra a la carpeta del proyecto
cd precio-monitor

# 2. Crea un entorno virtual (aísla las dependencias del proyecto)
python -m venv venv

# 3. Actívalo
# En Windows (PowerShell):
venv\Scripts\Activate.ps1
# En Mac/Linux:
source venv/bin/activate

# 4. Instala Playwright
pip install playwright

# 5. Descarga el navegador que va a usar Playwright (~150 MB)
playwright install chromium
```

## Probar el scraper

Asegúrate de tener `productos_competencia.csv` en la raíz de la carpeta
`precio-monitor/` (al mismo nivel que la carpeta `scraper/`).

Luego:

```bash
python scraper/farmatodo.py
```

Deberías ver algo como:

```
Voy a scrapear 3 URLs de Farmatodo...

-> La Sante (propio)
   Nombre: Acetaminofén 650 mg x 10 Tabletas La Santé
   Precio: Bs 245.00

-> Calox (alternativa)
   Nombre: Acetaminofén 650mg x 10 Tabletas Calox
   Precio: Bs 312.50

-> Atamel (alternativa)
   Nombre: Acetaminofén 500 mg Atamel x 20 Tabletas
   Precio: Bs 480.00
```

## Si algo falla

Manda lo que muestra la terminal — error completo — y lo arreglamos.
Lo más probable es que algún selector necesite ajuste para Farmatodo
porque su HTML cambia ocasionalmente.

## Estructura de la carpeta

```
precio-monitor/
├── productos_competencia.csv
├── scraper/
│   └── farmatodo.py
└── venv/   (lo crea Python al hacer python -m venv venv)
```
