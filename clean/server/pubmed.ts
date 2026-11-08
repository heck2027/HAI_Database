// Minimal PubMed efetch XML parser (no extra dependencies).

export interface PubMedArticle {
  pmid: string;
  title: string;
  abstract: string;
  journal: string;
  year?: number;
  publicationTypes: string[];
  affiliations: string;
  retracted: boolean;
}

function decodeXml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parsePubMedXml(xml: string): PubMedArticle[] {
  const articles: PubMedArticle[] = [];
  const blocks = xml.match(/<PubmedArticle[\s>][\s\S]*?<\/PubmedArticle>/g) || [];
  for (const b of blocks) {
    const pmid = (b.match(/<MedlineCitation[^>]*>\s*<PMID[^>]*>(\d+)<\/PMID>/) || [])[1];
    if (!pmid) continue;
    const title = decodeXml((b.match(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/) || [])[1] || '');
    const abstractParts: string[] = [];
    for (const m of b.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)) {
      const label = (m[1].match(/Label="([^"]+)"/) || [])[1];
      const text = decodeXml(m[2]);
      if (text) abstractParts.push(label ? `${label}: ${text}` : text);
    }
    const journal = decodeXml((b.match(/<Journal>[\s\S]*?<Title>([\s\S]*?)<\/Title>/) || [])[1] || '');
    const pubDate = (b.match(/<PubDate>([\s\S]*?)<\/PubDate>/) || [])[1] || '';
    const yearStr = (pubDate.match(/<Year>(\d{4})<\/Year>/) || pubDate.match(/(\d{4})/) || [])[1];
    const publicationTypes = [...b.matchAll(/<PublicationType[^>]*>([\s\S]*?)<\/PublicationType>/g)].map((m) =>
      decodeXml(m[1])
    );
    const affiliations = [...b.matchAll(/<Affiliation[^>]*>([\s\S]*?)<\/Affiliation>/g)]
      .map((m) => decodeXml(m[1]))
      .join(' | ')
      .slice(0, 700);
    const retracted =
      publicationTypes.some((t) => /^Retracted Publication$/i.test(t)) ||
      /<CommentsCorrections[^>]*RefType="RetractionIn"/i.test(b);
    articles.push({
      pmid,
      title,
      abstract: abstractParts.join('\n'),
      journal,
      year: yearStr ? parseInt(yearStr, 10) : undefined,
      publicationTypes,
      affiliations,
      retracted,
    });
  }
  return articles;
}

