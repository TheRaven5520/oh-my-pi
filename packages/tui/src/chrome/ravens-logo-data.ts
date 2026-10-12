// Baltimore Ravens artwork from the official NFL club-logo endpoint.
// https://static.www.nfl.com/t_q-best/league/api/clubs/logos/BAL
// Cropped to viewBox 0 125 500 245; team colors lifted for dark terminal backgrounds.
// Team and NFL marks belong to their respective owners.
export const RAVENS_PALETTE = ["302c38", "392078", "9a7611", "fffffe", "c8102e"] as const;
export const RAVENS_PIXELS = {
	"8": ["..2211..", ".212112.", ".1211222", "....2..."],
	"16": [
		".....22222......",
		"...212222112....",
		"..20112211002...",
		".22202221121222.",
		"...2121111233322",
		"...2122201122222",
		"........22......",
		"........2.......",
	],
	"24": [
		".........2222...........",
		"......2210110022........",
		"....22012232211022......",
		"...2201112322111122.....",
		"..2202012222110410122...",
		".222222122221112213322..",
		".2...201211111132323332.",
		"....22222000011133333222",
		".......322.2010022222222",
		"...........22122........",
		"............22..........",
		".............1..........",
	],
} as const;
