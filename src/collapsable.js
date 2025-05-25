const elements = document.getElementsByClassName("fancy_collapse")

for (let index = 0; index < elements.length; index++) {
	const element = elements[index]
    
	const content = element.previousElementSibling
    const orig = content.style.marginTop

	element.addEventListener("click", (event) => {
		if (content.style.marginTop === orig) {
			content.style.marginTop = "-100%"
            element.innerHTML = "Expand"
		} else {
			content.style.marginTop = orig
            element.innerHTML = "Collapse"
		}
	})
}