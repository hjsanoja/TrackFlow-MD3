/**
 * Helper utility for parsing unidosis / packaging unit counts from strings (e.g. "30 tab", "10 cap", "100 ml", "Caja x 14")
 * and calculating prices per unidosis (unit price vs full box price).
 */

export function parseUnidosisCount(tamanoStr = '', nombreStr = '', explicitCount = null) {
  if (explicitCount !== null && explicitCount !== undefined && explicitCount !== '' && !isNaN(Number(explicitCount)) && Number(explicitCount) > 0) {
    return Number(explicitCount);
  }

  const str = `${tamanoStr || ''} ${nombreStr || ''}`.toLowerCase().trim();
  if (!str) return 1;

  // Check if product is a continuous liquid/topical form without discrete sub-units
  const isContinuousForm = /(?:jarabe|crema|unguento|pomada|gel|locion|gotas|spray|suspension|solucion|emulsion|elixir|shampoo|colirio|suero|solución|suspensión|loción)\b/i.test(str);
  const hasDiscreteUnits = /(?:tab|tabletas?|caps?|capsulas?|comprimidos?|comp|sobres?|ampollas?|amps?|viales?|grageas?|pildoras?|supositorios?)\b/i.test(str);

  // If it's a liquid/cream/topical form and doesn't explicitly mention discrete units (like ampollas/sobres/tabletas), return 1.
  if (isContinuousForm && !hasDiscreteUnits) {
    return 1;
  }

  // 1. Look for count followed by DISCRETE unit words ONLY (strictly excluding volume/weight like ml, g, gr, mg, mcg, %)
  const matchUnit = str.match(/(\d+)\s*(?:tab|tabletas?|caps?|capsulas?|comprimidos?|comp|sobres?|ampollas?|amps?|viales?|unid|unidades|grageas?|pildoras?|supositorios?)\b/i);
  if (matchUnit && Number(matchUnit[1]) > 0) {
    return Number(matchUnit[1]);
  }

  // 2. Look for packaging pattern like "x 30", "caja x 30", "x30", "pack x 20"
  // BUT make sure it's NOT followed by volume/weight units like ml, g, gr, gramos, mg, mcg, %
  const matchX = str.match(/(?:caja|empaque|pack|estuche)?\s*x\s*(\d+)(?!\s*(?:ml|g|gr|gramos|mg|mcg|%|oz|l)\b)/i);
  if (matchX && Number(matchX[1]) > 0) {
    return Number(matchX[1]);
  }

  // 3. Look for "caja de 30", "de 30", "por 30" (provided it's not followed by volume/weight units)
  const matchDe = str.match(/(?:caja|empaque|presentacion)\s+(?:de|por|con)?\s*(\d+)(?!\s*(?:ml|g|gr|gramos|mg|mcg|%|oz|l)\b)/i);
  if (matchDe && Number(matchDe[1]) > 0) {
    return Number(matchDe[1]);
  }

  // 4. If tamanoStr itself is just a bare number like "30" or "10"
  if (tamanoStr && /^\s*(\d+)\s*$/.test(tamanoStr)) {
    const val = Number(tamanoStr.trim());
    if (val > 0) return val;
  }

  return 1;
}

/**
 * Returns adjusted price based on mode ('empaque' or 'unidosis').
 */
export function getPriceByMode(price, tamanoStr, nombreStr, explicitCount, mode = 'empaque') {
  if (price === null || price === undefined || isNaN(Number(price))) return null;
  const numPrice = Number(price);
  if (mode !== 'unidosis') return numPrice;

  const count = parseUnidosisCount(tamanoStr, nombreStr, explicitCount);
  return numPrice / Math.max(count, 1);
}

/**
 * Formats price label or suffix based on mode
 */
export function getUnitLabel(mode = 'empaque', currency = 'usd') {
  const symbol = currency === 'usd' ? '$' : 'Bs';
  return mode === 'unidosis' ? `${symbol}/unidad` : `${symbol}`;
}
