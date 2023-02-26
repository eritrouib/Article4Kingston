install.packages(c("rgdal", "maptools", "sp", "leaflet"))
install.packages("leaflet.extras")
##We need latest leaflet package from Github, as CRAN package is too old.
devtools::install_github('rstudio/leaflet')
devtools::install_github('bhaskarvk/leaflet.extras')

library(rgdal)
library(maptools)
library(sp)
library(leaflet)
library(leaflet.extras)

getwd() 
setwd("C:/Users/User/Documents/R_shiny/git")

shapefile <- readOGR(dsn="C:/Users/User/Documents/R_shiny/git", layer="article4")
proj4string(shapefile)
shapefile <- spTransform(shapefile, CRS("+proj=longlat +datum=WGS84"))

# create map
map <- leaflet() %>%
  addProviderTiles(providers$OpenStreetMap.MapQuestUK) %>%
  addPolygons(data = shapefile) %>% 
  addSearchOSM()

