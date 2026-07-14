# LogiSuite

Application de gestion de flotte de livraison. Frontend React + backend Xano.

## Démarrer en local

```bash
npm install
npm run dev
```

L'app se lance sur `http://localhost:5173`.

## Déployer sur GitHub + Vercel

1. **GitHub** : crée un nouveau dépôt, puis pousse ce dossier dedans :
   ```bash
   git init
   git add .
   git commit -m "LogiSuite"
   git branch -M main
   git remote add origin https://github.com/TON-COMPTE/logisuite.git
   git push -u origin main
   ```

2. **Vercel** : va sur [vercel.com](https://vercel.com), "Add New Project", importe ce dépôt GitHub.
   Vercel détecte automatiquement Vite — laisse les réglages par défaut et clique "Deploy".

3. **Variables d'environnement (optionnel)** : si tu changes un jour d'URL Xano, ajoute dans
   Vercel → Project Settings → Environment Variables :
   - `VITE_XANO_AUTH_URL`
   - `VITE_XANO_DATA_URL`

   Sans ça, l'app utilise les URLs par défaut déjà configurées dans `src/api/xano.js`.

## Premier lancement

1. Ouvre l'app déployée.
2. Clique "Première configuration ? Créer le compte administrateur".
3. Crée ton compte (email + mot de passe) — il devient automatiquement Exploitant.
4. Depuis l'onglet **Dépôts**, crée ton premier dépôt.
5. Depuis l'onglet **Équipe**, crée les comptes de tes chauffeurs.
6. Depuis **Flotte**, crée ta première tournée.

## ⚠️ Points à vérifier lors du premier test

Cette version connecte LogiSuite à un backend Xano que tu as construit toi-même via une IA.
Certains noms exacts (segments d'URL, clé sous laquelle les arrêts apparaissent dans une
tournée) ont été devinés d'après la convention la plus courante de Xano — ils peuvent
nécessiter un petit ajustement :

- **`src/api/xano.js`**, tout en haut, l'objet `RESOURCES` liste les segments d'URL
  (`depots`, `produits`, `arrets`, `tournois`, `utilisateurs`). Compare avec la
  Documentation Swagger de ton groupe API Xano et corrige si un nom diffère.
- **`STOPS_ADDON_KEYS`** dans le même fichier : c'est le nom sous lequel Xano renvoie les
  arrêts imbriqués dans chaque tournée. Si les tournées apparaissent sans leurs arrêts,
  ouvre la réponse de `GET /tournois` dans l'onglet Network du navigateur pour voir le vrai
  nom de ce champ, et ajoute-le en premier dans cette liste.
- Si une action échoue, un message d'erreur s'affiche maintenant à l'écran (plutôt qu'une
  erreur silencieuse) — copie ce message, ça permettra de corriger rapidement le point exact
  qui coince.

## Structure du projet

```
src/
  App.jsx           → toute l'application (composants, logique)
  main.jsx          → point d'entrée React
  api/
    xano.js         → client HTTP vers Xano (auth + CRUD)
    normalize.js     → conversion entre le format Xano et le format interne de l'app
```
