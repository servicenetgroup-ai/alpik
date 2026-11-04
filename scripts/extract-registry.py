# One-off: converts the registry embedded in the original HTML into src/registry.js
import re, json, sys
src = open(sys.argv[1], encoding='utf-8').read()
rows = re.findall(r'\{ num: (\d+), code: "([^"]+)", unit: "([^"]+)", owner: "((?:[^"\\]|\\.)+)", idInfo: "([^"]+)" \}', src)
assert len(rows) == 118
norm = lambda s: re.sub(r'[^A-Z0-9]', '', s.upper())
units = []
for num, code, unit, owner, idinfo in rows:
    owner = owner.replace('\\"', '"')
    area = float(re.search(r'\(([\d.]+) sq\.m\)', unit).group(1))
    typ = 'apartment' if 'Apt' in unit else 'auxiliary' if 'Aux' in unit else 'commercial' if 'Comm' in unit else 'parking'
    label = re.search(r'N(\d+ა?)', unit).group(1)
    floor = 'M' if 'Mansard' in unit else re.search(r'სართ\. (-?\d+)', unit).group(1)
    segs = []
    for part in idinfo.split('|'):
        kind = re.match(r'\s*(P/N|C/N|ID):', part).group(1)
        vals = [norm(v) for v in re.sub(r'^\s*(P/N|C/N|ID):\s*', '', part.strip()).split(',')]
        segs.append((kind, [v for v in vals if v]))
    n = max(len(v) for _, v in segs)
    ka, _, en = owner.partition(' / ')
    split = lambda s: [x.strip() for x in re.split(r'\s*&\s*|,\s*', s) if x.strip()]
    kas, ens = split(ka), split(en or ka)
    is_company = 'LLC' in owner
    owners = []
    for i in range(n):
        ids = [{'kind': k, 'value': v[i]} for k, v in segs if i < len(v)]
        owners.append({
            'name_ka': kas[i] if len(kas) == n else ka.strip(),
            'name_en': ens[i] if len(ens) == n else (en or ka).strip(),
            'type': 'company' if is_company else 'person',
            'ids': ids})
    units.append({'num': int(num), 'code': code, 'type': typ, 'label': label, 'floor': floor, 'area': area, 'owners': owners})
open('src/registry.js','w',encoding='utf-8').write('// Public Registry extract No. 882026185899 (06.03.2026), units not owned by Red-Co LLC.\nexport default ' + json.dumps(units, ensure_ascii=False, indent=1) + ';\n')
print(len(units), sum(len(u['owners']) for u in units))
for u in units:
    if len(u['owners']) > 1: print(u['num'], [(o['name_en'], [i['value'] for i in o['ids']]) for o in u['owners']])
