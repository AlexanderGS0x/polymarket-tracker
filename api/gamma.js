export default async function handler(req, res) {
  const { path } = req.query;
  const url = `https://gamma-api.polymarket.com/${path}`;
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
