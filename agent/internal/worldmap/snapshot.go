package worldmap

import "time"

// Snapshot is GET /map. Coordinates are world metres rounded to whole
// metres: x east, z north, origin at the world centre. Platform ids (portal
// tag authors, pin authors, bed and grave owner ids) are never read into it.
// Names (grave and bed owners, portal tags, pin names, crafters) are empty
// when the builder runs with ShowNames off. Storage lists only containers a
// player built: world-generated chests (treasure, shipwreck, dungeon loot)
// and their contents are never read into it.
type Snapshot struct {
	Meta         Meta          `json:"meta"`
	Land         Land          `json:"land"`
	Explored     Explored      `json:"explored"`
	Pins         []Pin         `json:"pins"`
	Portals      []Portal      `json:"portals"`
	Tombstones   []Tombstone   `json:"tombstones"`
	Beds         []Bed         `json:"beds"`
	Vehicles     []Vehicle     `json:"vehicles"`
	Bases        []Base        `json:"bases"`
	Locations    []Location    `json:"locations"`
	TerrainEdits []TerrainEdit `json:"terrainEdits"`
	Storage      []Container   `json:"storage"`
	Stats        Stats         `json:"stats"`
}

type Meta struct {
	SeedName        string    `json:"seedName"`
	Seed            int32     `json:"seed"`
	WorldGenVersion int32     `json:"worldGenVersion"`
	Day             int64     `json:"day"`
	NetTime         float64   `json:"netTime"`
	Generation      int       `json:"generation"`
	SavedAt         time.Time `json:"savedAt"`
	GeneratedAt     time.Time `json:"generatedAt"`
	// ShowNames says whether names were exported (MAP_SHOW_NAMES).
	ShowNames bool `json:"showNames"`
}

// Land is the zone grid: Size x Size zones of ZoneSize metres, row-major
// from (Min, Min) going east (x) then north (z). Each byte of Data
// (base64) is 0 for a zone the world never generated, 1 for a generated zone
// without objects (open water), and 2..255 for log-scaled object density
// (land, more is denser vegetation and building).
type Land struct {
	ZoneSize int    `json:"zoneSize"`
	Min      int    `json:"min"`
	Size     int    `json:"size"`
	Data     []byte `json:"data"`
}

// Explored is the union of every cartography table's explored mask: Size x
// Size pixels of MetersPerPixel, centred on the world origin, row-major from
// the south-west corner (col = x/12+1024, row = z/12+1024). RLE (base64) is
// a list of LEB128 run lengths over the row-major pixels, alternating
// unexplored, explored, ..., starting with unexplored. Available is false
// when the world has no cartography table.
type Explored struct {
	Available      bool   `json:"available"`
	Tables         int    `json:"tables"`
	Size           int    `json:"size"`
	MetersPerPixel int    `json:"metersPerPixel"`
	Pixels         int    `json:"pixels"`
	RLE            []byte `json:"rle"`
}

// Pin is a map pin shared through a cartography table.
type Pin struct {
	Type int    `json:"type"`
	Kind string `json:"kind"`
	Name string `json:"name"`
	X    int    `json:"x"`
	Z    int    `json:"z"`
}

type Portal struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	X          int    `json:"x"`
	Z          int    `json:"z"`
	Tag        string `json:"tag"`
	PairedWith string `json:"pairedWith,omitempty"`
}

type Tombstone struct {
	X     int    `json:"x"`
	Z     int    `json:"z"`
	Owner string `json:"owner"`
	// Day is the in-game day of the death; -1 when unknown.
	Day int64 `json:"day"`
	// Items is what the grave holds, in slot order.
	Items []Item `json:"items"`
}

type Bed struct {
	X     int    `json:"x"`
	Z     int    `json:"z"`
	Owner string `json:"owner"`
}

// Vehicle is a ship or a cart. ID names its entry in Snapshot.Storage when a
// player built it.
type Vehicle struct {
	ID   string `json:"id,omitempty"`
	Kind string `json:"kind"`
	X    int    `json:"x"`
	Z    int    `json:"z"`
}

// Base is a cluster of player-built pieces: 64 m zones with at least one
// piece, joined when they touch (8 neighbours).
type Base struct {
	X        int      `json:"x"`
	Z        int      `json:"z"`
	Pieces   int      `json:"pieces"`
	Zones    int      `json:"zones"`
	HasBed   bool     `json:"hasBed"`
	Stations []string `json:"stations"`
}

// Location is a generated point of interest of a listed kind. Placed means
// the game has built it (its zone was loaded); Explored means it lies inside
// the explored mask or within 64 m of a player-built piece.
type Location struct {
	Kind     string `json:"kind"`
	Name     string `json:"name"`
	X        int    `json:"x"`
	Z        int    `json:"z"`
	Placed   bool   `json:"placed"`
	Explored bool   `json:"explored"`
}

// TerrainEdit is the number of terrain cells (of 65x65 per zone) a zone's
// terrain compiler has raised, lowered or painted.
type TerrainEdit struct {
	X     int `json:"x"`
	Z     int `json:"z"`
	Cells int `json:"cells"`
}

// Container is a chest, cart or ship a player built (it carries a creator),
// with its inventory. ID is the prefab and the rounded position, stable for
// as long as it stays put. Width x Height is the inventory grid: the game's
// size where known, never smaller than the slots in use. Unreadable is set
// when the inventory did not decode; Items is then empty. Y is the height in
// metres (0.05 m steps), which tells apart chests stacked on one spot.
type Container struct {
	ID         string  `json:"id"`
	Kind       string  `json:"kind"`
	Prefab     string  `json:"prefab"`
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
	Z          float64 `json:"z"`
	Width      int     `json:"width"`
	Height     int     `json:"height"`
	Items      []Item  `json:"items"`
	Unreadable bool    `json:"unreadable,omitempty"`
}

// Item is one stack in a container. Name is the item prefab ("#hash" when
// unknown), Type the game's item type ("Material", "Helmet", ...; empty when
// unknown). Quality is omitted at 1; Durability is set only for things that
// wear (weapons, armour, tools). Crafter is the crafter's name, only with
// ShowNames; the crafter id is never read.
type Item struct {
	Name       string   `json:"name"`
	Type       string   `json:"type,omitempty"`
	Stack      int      `json:"stack"`
	Quality    int      `json:"quality,omitempty"`
	Durability *float64 `json:"durability,omitempty"`
	Crafter    string   `json:"crafter,omitempty"`
	X          int      `json:"x"`
	Y          int      `json:"y"`
}

type Stats struct {
	ZDOs            int     `json:"zdos"`
	Chunks          int     `json:"chunks"`
	ChunksParsed    int     `json:"chunksParsed"`
	ChunksFailed    int     `json:"chunksFailed"`
	Pieces          int     `json:"pieces"`
	GeneratedZones  int     `json:"generatedZones"`
	LocationsTotal  int     `json:"locationsTotal"`
	LocationsPlaced int     `json:"locationsPlaced"`
	BuildSeconds    float64 `json:"buildSeconds"`
}
